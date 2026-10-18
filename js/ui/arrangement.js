// アレンジ画面(#/p/:id/arrange)。DAW のアレンジ画面のように、トラックを縦に並べ、クリップを小節単位で置く。
// 上端のルーラーの下にスケール(転調)の段と、セクションマーカーの段がある。マーカーはボードのセクションを指し、名前と色はそちらに従う。
// クリップは、属するセクションのレーンにタスク(連動タスク)として出る。だから、セクションマーカーの範囲の外には
// 新しく置けない(作る・動かす・伸ばす)。マーカーを動かしたり消したりして範囲の外になったクリップは、そのまま残す。
//
// 位置と幅は CSS 変数(--start は1始まりの小節、--len は小節数、--bar は1小節の幅)で決め、計算は CSS に任せる。
//
// クリップは MIDI クリップでもある。ダブルクリックで下にピアノロールを開き、ツールバーから OS の MIDI 音源で全体を再生する。
// ピアノロールのパネルは再描画で作り直さない(編集中の状態を持っているため)。作り直すのは view の中だけ。

import * as actions from '../actions.js';
import {
   arrangementBars, canPlace, canShiftSelection, clipEnd, clipSection, markerClips, markerSpans, UNTITLED_CLIP,
} from '../domain/arrangement.js';
import {
   audibleNotes, audibleTrackIds, audioFileName, CENTER_PAN, clipTickRange, clipTicks, DEFAULT_VOLUME, MAX_BPM, MIN_BPM, playbackInput, PPQ,
   projectBpm, projectScales, scaleLabel, soundLabel, TICKS_PER_BAR, trackMix, trackSound,
} from '../domain/midi.js';
import { sortByOrder } from '../domain/order.js';
import { sectionColors } from '../domain/project.js';
import { repo, subscribe } from '../state.js';
import { choiceDialog } from './components/dialog.js';
import { h, icon, keepFocus } from './components/dom.js';
import { knob } from './components/knob.js';
import { openMenu } from './components/menu.js';
import { drawMarquee, trackPointer } from './components/pointer.js';
import { createSortable, domIndex } from './components/sortable.js';
import { reportError, showProgress, showToast } from './components/toast.js';
import { addTrackDialog, deleteTrackDialog, openScaleMenu, renameTrackDialog, scaleDialog, trackSoundDialog } from './arrangementDialogs.js';
import { barRange, createClipDrawer } from './clipDrawer.js';
import { arrangementMidi, downloadBlob, downloadMidi } from './midiExport.js';
import { renderWav } from '../audioExport.js';
import * as sound from '../synth.js';
import { createIdleTimer } from './idleTimer.js';
import { createPianoRoll } from './pianoRoll.js';
import { projectHead } from './projectHeader.js';
import { projectTabs } from './projectTabs.js';

const DRAG_THRESHOLD = 4; // これより動かなければクリック(詳細を開く・メニューを出す)として扱う(px)
// タッチでクリップを動かす・伸縮するときは、この時間だけ押さえてから(ms)。すぐ動かせばスクロールになる
const HOLD_MS = 350;
const HEAD_MIN = 216; // トラック名の列の幅(px)。名前が短ければこの幅
const HEAD_NAME_CHARS = 10; // 名前が長ければ、全角でこの文字数が入るところまで列を広げる
const SVG_NS = 'http://www.w3.org/2000/svg';

const clamp = (n, min, max) => Math.max(min, Math.min(n, max));
// パンの表記(64 が中央)。「L12」「中央」「R30」
const panLabel = (pan) => (pan === CENTER_PAN ? '中央' : pan < CENTER_PAN ? `L${CENTER_PAN - pan}` : `R${pan - CENTER_PAN}`);

export function mount(container, { id: projectId }) {
   const root = h('div', { class: 'arr-page' });
   const view = h('div', { class: 'arr-view' });
   container.append(root);

   let alive = true;
   let data = null;
   // 最後に編集してからの経過時間(ツールバーに出す)
   const idle = createIdleTimer(projectId);
   let sortable = null;
   // ドラッグ中に再描画すると、掴んでいる要素が消える。終わるまで待たせる
   let dragging = false;
   let renderPending = false;
   // ドラッグを終えた直後の click(ボタンの上で離すと起きる)を、クリックとして扱わない
   let suppressClick = false;
   const run = (promise) => promise.catch(reportError);
   // 画面を先に動かしてから保存する操作。失敗したら、保存済みの状態で描き直す
   const runPlaced = (promise) => promise.catch((error) => {
      reportError(error);
      render();
   });

   // 選んでいるクリップ(詳細かピアノロールで開いているもの)に印を付ける
   function markSelected() {
      const clipId = drawer.clipId ?? pianoRoll.clipId;
      for (const el of root.querySelectorAll('.clip.is-selected')) el.classList.remove('is-selected');
      if (clipId) root.querySelector(`.clip[data-clip-id="${CSS.escape(clipId)}"]`)?.classList.add('is-selected');
   }

   // 複数選択(Ctrl+ドラッグで囲む、Ctrl+クリック、Ctrl+A)で選んでいるクリップ。まとめて横に動かすためのもの。
   // 詳細やピアノロールで開いているクリップ(is-selected)とは別に持つ
   let picked = new Set();

   function markPicked() {
      for (const el of root.querySelectorAll('.clip')) el.classList.toggle('is-picked', picked.has(el.dataset.clipId));
   }

   function setPicked(ids) {
      picked = new Set(ids);
      markPicked();
   }
   const drawer = createClipDrawer(projectId, {
      onSelectionChange: () => markSelected(),
      onOpenPianoRoll: (clipId) => openPianoRoll(clipId),
      onDuplicate: (clipId) => startDuplicate(clipId),
   });
   const pianoRoll = createPianoRoll({
      projectId,
      onSelectionChange: () => markSelected(),
      // そのクリップだけを、頭からループで鳴らす(ループ中にもう一度押すと止める)
      onPlayClip: (clip) => {
         if (isLooping(clip.id)) sound.stop();
         else startPlayback(clipTickRange(clip).fromTick, clip.id).catch(reportPlayError);
      },
      isLooping: (clipId) => isLooping(clipId),
      onSeek: (tick) => seek(tick, { keepLoop: true }),
      onOpenDetail: (clipId) => drawer.open(clipId),
      isPlaying: () => sound.isPlaying(),
      // ツールバー(再生・BPM)は隠さない。複製の案内が出ていれば、その下まで
      topLimit: () => (root.querySelector('.arr-placing') ?? root.querySelector('.board-toolbar'))?.getBoundingClientRect().bottom ?? 0,
   });
   root.append(view, pianoRoll.el);

   // クリップを開く。ピアノロールを開いている間は、そちらに切り替える(詳細はピアノロールの見出しから開ける)
   function openClip(clipId) {
      if (pianoRoll.clipId) pianoRoll.open(clipId);
      else drawer.open(clipId);
   }

   function openPianoRoll(clipId) {
      drawer.close();
      pianoRoll.open(clipId);
   }

   // ---- 再生 ----
   // 再生を始める位置は、ルーラーを押して決める。止めても動かない。
   // アレンジのルーラーは小節単位、ピアノロールのルーラーはグリッドの単位で決めるので、曲の頭からの tick で持つ

   let startTick = 0;
   let played = null; // 再生中の中身(playbackInput)。変わったら syncPlayback で差し替える
   // ループで鳴らしているクリップ(ピアノロールの再生ボタン)。そのクリップのノートだけを、トラックのミュート・ソロに関わらず、
   // 止めるまでくり返す(FL Studio のパターン再生のように、編集しながら聞く)。全体を再生しているときは null
   let loopClipId = null;
   let frame = null;

   const isLooping = (clipId) => sound.isPlaying() && loopClipId != null && loopClipId === clipId;
   const playbackData = () => playbackInput(data, loopClipId);

   // clipId を渡すと、そのクリップだけをループで鳴らす(fromTick はクリップの範囲に収める)
   async function startPlayback(fromTick, clipId = null) {
      loopClipId = clipId;
      const input = playbackData();
      if (!input) {
         sound.stop();
         return;
      }
      played = input;
      const { loop } = input;
      const from = loop ? (fromTick >= loop.fromTick && fromTick < loop.toTick ? fromTick : loop.fromTick) : Math.max(0, fromTick);
      await sound.play({ ...input, fromTick: from });
      follow();
   }

   // 再生中に中身(ミュート・ソロ、音色・音量・パン、ノート)が変わったら、止めずに差し替える(伸びている音を途切れさせない)。
   // BPM が変わったときだけは、時刻の計算が変わるので、いまの位置から鳴らし直す。
   // ループのクリップを動かしたり伸縮したりしたときも、範囲が変わるので、クリップの中の同じ位置から鳴らし直す。消えたら止める
   async function syncPlayback() {
      if (!sound.isPlaying() || !played) return;
      const input = playbackData();
      if (!input) {
         sound.stop();
         return;
      }
      const tick = sound.playbackTick() ?? 0;
      if (input.loop && JSON.stringify(input.loop) !== JSON.stringify(played.loop)) {
         const length = input.loop.toTick - input.loop.fromTick;
         await startPlayback(input.loop.fromTick + ((tick - played.loop.fromTick) % length), loopClipId);
         return;
      }
      if (input.bpm !== played.bpm) {
         await startPlayback(tick, loopClipId);
         return;
      }
      const sent = new Set(played.setup.map((m) => JSON.stringify(m)));
      const eventsChanged = JSON.stringify(input.events) !== JSON.stringify(played.events);
      sound.updatePlayback({
         messages: input.setup.filter((m) => !sent.has(JSON.stringify(m))),
         events: eventsChanged ? input.events : undefined,
         endTick: input.endTick,
      });
      played = input;
   }

   // 保存を待たずに、手元のトラックを変えておく(ミュート・ソロを、すぐ音に効かせる)。
   // 保存が続けて走ると、先の保存のあとの読み直しには後の変更がまだ入っていない。古い値に一瞬戻って音が揺れないよう、
   // 保存がすべて終わるまでは、読み直したトラックに手元の変更を重ねる
   const localTracks = new Map(); // トラックの id → まだ保存し終えていない変更
   let localSaves = 0;
   const withLocal = (tracks) => tracks.map((t) => (localTracks.has(t.id) ? { ...t, ...localTracks.get(t.id) } : t));

   function setLocalTrack(trackId, patch) {
      localTracks.set(trackId, { ...localTracks.get(trackId), ...patch });
      data.tracks = withLocal(data.tracks);
      run(syncPlayback());
   }

   function saveLocal(promise) {
      localSaves++;
      promise
         .catch((error) => {
            reportError(error);
            localTracks.clear(); // 保存済みの状態を読み直す
         })
         .finally(() => {
            if (--localSaves > 0) return;
            localTracks.clear();
            run(refresh());
         });
   }

   function togglePlayback() {
      if (sound.isPlaying()) sound.stop();
      else startPlayback(startTick).catch(reportPlayError);
   }

   // 再生を始める位置を変える(再生中なら、そこから鳴らし直す)。
   // keepLoop はピアノロールのルーラーから変えたとき。クリップをループで鳴らしていれば、ループのまま、その位置から鳴らし直す
   // (アレンジのルーラーからなら、全体の再生に戻す)
   function seek(tick, { keepLoop = false } = {}) {
      startTick = Math.max(0, tick);
      if (sound.isPlaying()) startPlayback(startTick, keepLoop ? loopClipId : null).catch(reportPlayError);
      pianoRoll.setStart(startTick);
      render();
   }

   // 「3小節目」「3小節目の2拍目」。拍の途中なら「3小節目の2.5拍目」のように小数で(3連は 2.33 のように丸める)
   function startLabel() {
      const bar = Math.floor(startTick / TICKS_PER_BAR) + 1;
      const beat = Number(((startTick % TICKS_PER_BAR) / PPQ + 1).toFixed(2));
      return beat === 1 ? `${bar}小節目` : `${bar}小節目の${beat}拍目`;
   }

   // 再生の失敗を知らせる。音源が選ばれていなければ、設定画面へ行けるようにする
   function reportPlayError(error) {
      if (!(error instanceof sound.NoSoundFontError)) {
         reportError(error);
         return;
      }
      showToast(error.message, { actionLabel: '設定を開く', onAction: () => { location.hash = '#/settings'; } });
   }

   // 再生位置の線を動かし、画面の外へ出そうなら横にスクロールして追いかける
   function follow() {
      cancelAnimationFrame(frame);
      const tick = sound.playbackTick();
      const line = root.querySelector('.arr-playhead');
      pianoRoll.setPlayhead(tick);
      if (line) {
         line.hidden = tick == null;
         if (tick != null) {
            const bar = 1 + tick / TICKS_PER_BAR;
            line.style.setProperty('--start', String(bar));
            const scroller = root.querySelector('.arr');
            const x = line.offsetLeft;
            const head = root.querySelector('.arr-corner')?.offsetWidth ?? 0;
            if (x > scroller.scrollLeft + scroller.clientWidth - 40 || x < scroller.scrollLeft + head) {
               scroller.scrollLeft = x - head - 40;
            }
         }
      }
      if (tick != null) frame = requestAnimationFrame(follow);
   }

   const unwatchSynth = sound.onSynthChange(() => {
      if (data) render();
      if (!sound.isPlaying()) follow();
      pianoRoll.updatePlayState();
   });
   // 音源の読み込み(数MB〜数十MB)には時間が掛かるので、画面を開いたときに裏で始めておく。
   // 選ばれていなければ、再生を押したときに知らせる
   sound.prepareSynth().catch(() => {});

   // スペースキーは、どこにフォーカスがあっても再生・停止にする(DAW と同じく、ボタンやクリップを触ったあとも
   // すぐスペースで聞き直せるように。ボタンやクリップは Enter で押せる)。
   // ただし文字を打つ欄(クリップ名・詳細・リファレンスなど)では空白を打つので譲り、ダイアログを開いている間もそちらに任せる
   const isTextEntry = (el) => Boolean(el.closest?.('textarea, [contenteditable]:not([contenteditable="false"])'))
      || (el.tagName === 'INPUT' && ['text', 'search', 'url', 'email', 'password', 'tel'].includes(el.type));
   const onKeydown = (e) => {
      if (e.key === 'Escape' && placing && !document.querySelector('dialog[open], .menu')) {
         e.preventDefault();
         stopDuplicate();
         return;
      }
      if (onPickKeydown(e)) return;
      if (e.code !== 'Space' || e.defaultPrevented || isTextEntry(e.target)) return;
      if (document.querySelector('dialog[open]') || !data?.project) return;
      // 押しっぱなしのくり返しは無視するが、ボタンなどの既定の動き(押す・開く)は、くり返しの分も止める
      e.preventDefault();
      if (!e.repeat) togglePlayback();
   };
   // ボタンはスペースを離したときに押される。押した分を再生・停止にしたので、ボタンとしては押させない
   const onKeyup = (e) => {
      if (e.code !== 'Space' || isTextEntry(e.target) || document.querySelector('dialog[open]')) return;
      e.preventDefault();
   };
   document.addEventListener('keyup', onKeyup);
   document.addEventListener('keydown', onKeydown);

   // 複数選択のキー操作。Ctrl+A で全部を選び、←→ で選んだものを1小節ずつ動かし、Esc で選択を外す。
   // 入力欄やピアノロール・クリップ詳細の中、ダイアログ・メニューを開いている間は、そちらの操作を優先する
   function onPickKeydown(e) {
      if (e.defaultPrevented || !data?.project) return false;
      if (e.target.closest?.('input, textarea, select, [contenteditable], .pr, .drawer, .knob')) return false;
      if (document.querySelector('dialog[open], .menu')) return false;
      if (e.key.toLowerCase() === 'a' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
         e.preventDefault();
         setPicked(data.clips.map((c) => c.id));
         return true;
      }
      if (!picked.size) return false;
      if (e.key === 'Escape') {
         e.preventDefault();
         setPicked([]);
         return true;
      }
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.ctrlKey && !e.metaKey && !e.altKey) {
         e.preventDefault();
         shiftPicked(e.key === 'ArrowRight' ? 1 : -1);
         return true;
      }
      return false;
   }

   // 選んだクリップを、まとめて横に bars 小節ずらす。置けない位置(重なる・範囲の外)なら動かさない。
   // 保存を待たずに動かしておく(続けて押したときも、動かした後の位置から数える)
   function shiftPicked(bars) {
      const ids = [...picked];
      if (!canShiftSelection(data.clips, data.markers, { clipIds: ids }, bars)) return;
      data.clips = data.clips.map((c) => (picked.has(c.id) ? { ...c, startBar: c.startBar + bars } : c));
      for (const clip of data.clips) {
         if (picked.has(clip.id)) {
            const el = root.querySelector(`.clip[data-clip-id="${CSS.escape(clip.id)}"]`);
            if (el) setPlace(el, clip);
         }
      }
      runPlaced(actions.shiftSelection(projectId, { clipIds: ids }, bars));
   }

   const sections = () => data.lanes.filter((l) => l.type === 'section');
   // 置けるか(同じトラックのクリップと重ならず、セクションマーカーの範囲に入っている)
   const placeable = (place, ignoreId = null) => canPlace(data.clips, place, ignoreId, data.markers);
   // マーカーがないと、どこにもクリップを置けない。黙って何も起きないと分からないので知らせる
   const needMarker = () => {
      if (data.markers.length) return false;
      showToast('先にセクションマーカーを置いてください(上の「セクション」の段を押す)');
      return true;
   };

   // ---- ドラッグ ----

   // ポインタの位置が何小節目か(1始まり)。範囲の外なら端の小節に丸める
   function barAt(el, clientX) {
      const rect = el.getBoundingClientRect();
      return clamp(Math.floor((clientX - rect.left) / (rect.width / data.bars)) + 1, 1, data.bars);
   }

   /**
    * ドラッグの共通部分。しきい値を超えて動いたら onMove(e) を呼び、離したら onEnd(moved) を呼ぶ。
    * ポインタは down.currentTarget が捕まえる(要素の外へ出ても追える)。
    * hold が真なら、タッチのときは HOLD_MS 押さえてから(onHold() を呼んで)ドラッグにする。それより先に指が動いたら
    * ブラウザのスクロールに任せて、onMove も onEnd も呼ばない(クリップの上から始めたスクロールで、動かしたり開いたりしない)。
    */
   function drag(down, { onMove, onEnd, hold = false, onHold }) {
      if (down.button !== 0) return;
      down.preventDefault(); // ドラッグ中に文字が選択されないようにする
      const target = down.currentTarget;
      const waitHold = hold && down.pointerType === 'touch';
      let held = !waitHold;
      let gaveUp = false;
      let timer = null;
      // 長押しが成立したら、指を動かしてもスクロールさせない(touch-action ではスクロールを許しているので、touchmove で止める)
      const blockScroll = (e) => {
         if (held) e.preventDefault();
      };
      if (waitHold) {
         timer = setTimeout(() => {
            held = true;
            onHold?.();
         }, HOLD_MS);
         target.addEventListener('touchmove', blockScroll, { passive: false });
      }
      let moved = false;
      dragging = true;
      trackPointer(target, down, {
         onMove: (e) => {
            if (gaveUp) return;
            if (!moved && Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < DRAG_THRESHOLD) return;
            if (!held) {
               gaveUp = true;
               clearTimeout(timer);
               return;
            }
            moved = true;
            onMove(e);
         },
         onEnd: (e) => {
            clearTimeout(timer);
            target.removeEventListener('touchmove', blockScroll);
            dragging = false;
            if (moved) {
               suppressClick = true;
               setTimeout(() => { suppressClick = false; });
            }
            // スクロールに任せた(または取り消された)ときは、押さなかったことにする
            if (!gaveUp && !(waitHold && !held && e.type === 'pointercancel')) onEnd(moved && e.type === 'pointerup');
            if (renderPending) {
               renderPending = false;
               render();
            }
         },
      });
   }

   function setPlace(el, { startBar, bars }) {
      el.style.setProperty('--start', String(startBar));
      el.style.setProperty('--len', String(bars));
   }

   // ドラッグ中の置き先。置けない位置(重なる)なら赤くする
   function showGhost(ghost, laneEl, place, ok) {
      if (ghost.parentElement !== laneEl) laneEl.append(ghost);
      setPlace(ghost, place);
      ghost.classList.toggle('is-invalid', !ok);
   }

   /** 空いているところをドラッグして、クリップを作る */
   function dragCreate(down, track) {
      const laneEl = down.currentTarget;
      const from = barAt(laneEl, down.clientX);
      const ghost = h('div', { class: 'clip-ghost' });
      let place = null;
      drag(down, {
         onMove: (e) => {
            const to = barAt(laneEl, e.clientX);
            place = { trackId: track.id, startBar: Math.min(from, to), bars: Math.abs(to - from) + 1 };
            showGhost(ghost, laneEl, place, placeable(place));
         },
         onEnd: (moved) => {
            ghost.remove();
            if (moved && needMarker()) return;
            if (!moved || !place || !placeable(place)) return;
            createClip(track, place);
         },
      });
   }

   function createClip(track, place) {
      run(actions.addClip(projectId, track.id, place).then((clip) => drawer.open(clip.id, { focusName: true })));
   }

   // ---- 複製の置き場所を選ぶ ----
   // 「クリップを複製」を押すと、同じ長さの置き先がポインタに付いて動く(トラックをまたげる)。
   // 押したところに置く。置けない位置(重なる・セクションの外)では赤くなり、押しても置かない。
   // Esc か右クリック、案内の「取り消し」でやめる。押す操作は捕まえて、作成やドラッグには渡さない

   let placing = null; // { clip, ghost, place }

   function startDuplicate(clipId) {
      const clip = data.clips.find((c) => c.id === clipId);
      if (!clip) return;
      drawer.close();
      placing = { clip, ghost: h('div', { class: 'clip-ghost' }), place: null };
      render();
   }

   function stopDuplicate() {
      if (!placing) return;
      placing.ghost.remove();
      placing = null;
      render();
   }

   // ポインタの下のトラックに、置き先を出す(トラックの外なら隠す)
   function trackPlacing(e) {
      const laneEl = document.elementFromPoint(e.clientX, e.clientY)?.closest('.arr-lane');
      if (!laneEl) {
         placing.ghost.remove();
         placing.place = null;
         return;
      }
      const { clip } = placing;
      const startBar = clamp(barAt(laneEl, e.clientX), 1, Math.max(1, data.bars - clip.bars + 1));
      placing.place = { trackId: laneEl.dataset.trackId, startBar, bars: clip.bars };
      showGhost(placing.ghost, laneEl, placing.place, placeable(placing.place));
   }

   const onPlacingMove = (e) => {
      if (placing) trackPlacing(e);
   };
   const onPlacingDown = (e) => {
      if (!placing || !e.target.closest?.('.arr')) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.button === 2) {
         stopDuplicate();
         return;
      }
      if (e.button !== 0) return;
      trackPlacing(e);
      const { clip, place } = placing;
      if (!place || !placeable(place)) return;
      placing.ghost.remove();
      placing = null;
      render();
      run(actions.duplicateClip(projectId, clip.id, place).then((copy) => drawer.open(copy.id)));
   };
   // 置いたあとに続く click・dblclick・右クリックのメニューも、下の要素に渡さない
   const onPlacingSwallow = (e) => {
      if (!placing || !e.target.closest?.('.arr')) return;
      e.preventDefault();
      e.stopPropagation();
   };
   root.addEventListener('pointermove', onPlacingMove);
   root.addEventListener('pointerdown', onPlacingDown, true);
   root.addEventListener('contextmenu', onPlacingSwallow, true);
   root.addEventListener('dblclick', onPlacingSwallow, true);

   function placingBar() {
      return h('div', { class: 'arr-placing', role: 'status' },
         icon('copy', 14),
         h('span', null, `「${placing.clip.name || UNTITLED_CLIP}」の複製を置く場所を押してください(Esc か右クリックで取り消し)`),
         h('button', { type: 'button', class: 'btn', onclick: () => stopDuplicate() }, '取り消し'));
   }

   /**
    * クリップを動かす。mode が 'move' なら位置(上下で別のトラックへも)、'start' / 'end' なら左端・右端を動かして伸縮する。
    * 動かさずに離したら、詳細を開く。
    */
   function dragClip(down, clip, mode) {
      const fromLane = down.currentTarget;
      const clipEl = fromLane.querySelector(`.clip[data-clip-id="${CSS.escape(clip.id)}"]`);
      const grab = barAt(fromLane, down.clientX) - clip.startBar; // クリップの何小節目を掴んだか
      const ghost = h('div', { class: 'clip-ghost' });
      let laneEl = fromLane;
      let place = null;
      drag(down, {
         hold: true,
         onHold: () => clipEl.classList.add('is-moving'),
         onMove: (e) => {
            if (mode === 'move') {
               laneEl = document.elementFromPoint(e.clientX, e.clientY)?.closest('.arr-lane') ?? laneEl;
            }
            const bar = barAt(laneEl, e.clientX);
            if (mode === 'move') {
               const startBar = clamp(bar - grab, 1, Math.max(1, data.bars - clip.bars + 1));
               place = { trackId: laneEl.dataset.trackId, startBar, bars: clip.bars };
            } else if (mode === 'end') {
               place = { trackId: clip.trackId, startBar: clip.startBar, bars: Math.max(1, bar - clip.startBar + 1) };
            } else {
               const startBar = Math.min(bar, clipEnd(clip));
               place = { trackId: clip.trackId, startBar, bars: clipEnd(clip) - startBar + 1 };
            }
            clipEl.classList.add('is-moving');
            showGhost(ghost, laneEl, place, placeable(place, clip.id));
         },
         onEnd: (moved) => {
            ghost.remove();
            clipEl.classList.remove('is-moving');
            if (!moved) {
               if (mode === 'move') openClip(clip.id);
               return;
            }
            const same = place && place.trackId === clip.trackId && place.startBar === clip.startBar && place.bars === clip.bars;
            // 重なる位置や、セクションマーカーの範囲の外で離したら、何もせず元の位置に残す
            if (!place || same || !placeable(place, clip.id)) return;
            // 保存を待たずに、置いた位置へ動かしておく
            setPlace(clipEl, place);
            if (laneEl !== fromLane) laneEl.append(clipEl);
            runPlaced(actions.placeClip(projectId, clip.id, place));
         },
      });
   }

   /**
    * Ctrl+ドラッグで囲んだクリップを選ぶ(Shift も押していれば、いまの選択に足す)。トラックをまたいで囲める。
    * 動かさずに離したら(Ctrl+クリック)、押したクリップの選択を切り替える。
    * 囲んでいる間にスクロールしても、範囲はトラックの上の位置で追う
    */
   function marqueeClips(down) {
      const area = root.querySelector('.arr-tracks');
      const scroller = root.querySelector('.arr');
      const base = down.shiftKey ? new Set(picked) : new Set();
      const local = (e) => {
         const rect = area.getBoundingClientRect();
         return { x: e.clientX - rect.left, y: e.clientY - rect.top };
      };
      const from = local(down);
      const underClip = down.target.closest('.clip')?.dataset.clipId ?? null;
      const box = h('div', { class: 'arr-marquee' });
      let last = down;
      const update = () => {
         if (box.parentElement !== area) area.append(box);
         const { left, right, top, bottom } = drawMarquee(box, from, local(last));
         const rect = area.getBoundingClientRect();
         const hit = [...area.querySelectorAll('.clip')].filter((el) => {
            const r = el.getBoundingClientRect();
            const x = r.left - rect.left;
            const y = r.top - rect.top;
            return x < right && x + r.width > left && y < bottom && y + r.height > top;
         }).map((el) => el.dataset.clipId);
         setPicked([...base, ...hit]);
      };
      scroller.addEventListener('scroll', update);
      drag(down, {
         onMove: (e) => {
            last = e;
            update();
         },
         onEnd: (moved) => {
            scroller.removeEventListener('scroll', update);
            box.remove();
            if (moved || !underClip) return;
            const next = new Set(picked);
            if (next.has(underClip)) next.delete(underClip);
            else next.add(underClip);
            setPicked(next);
         },
      });
   }

   /** 選んだクリップをまとめて横に動かす(上下には動かさない)。動かさずに離したら、選択を外して押したクリップを開く */
   function dragPicked(down, clip) {
      const fromLane = down.currentTarget;
      const grab = barAt(fromLane, down.clientX);
      const ids = [...picked];
      const clips = data.clips.filter((c) => picked.has(c.id));
      const ghosts = new Map(clips.map((c) => [c.id, h('div', { class: 'clip-ghost' })]));
      const clipEls = () => ids.map((id) => root.querySelector(`.clip[data-clip-id="${CSS.escape(id)}"]`)).filter(Boolean);
      let bars = 0;
      drag(down, {
         hold: true,
         onHold: () => {
            for (const el of clipEls()) el.classList.add('is-moving');
         },
         onMove: (e) => {
            bars = barAt(fromLane, e.clientX) - grab;
            const ok = canShiftSelection(data.clips, data.markers, { clipIds: ids }, bars);
            for (const c of clips) {
               const laneEl = root.querySelector(`.arr-lane[data-track-id="${CSS.escape(c.trackId)}"]`);
               if (laneEl) showGhost(ghosts.get(c.id), laneEl, { ...c, startBar: Math.max(1, c.startBar + bars) }, ok);
            }
            for (const el of clipEls()) el.classList.add('is-moving');
         },
         onEnd: (moved) => {
            for (const ghost of ghosts.values()) ghost.remove();
            for (const el of clipEls()) el.classList.remove('is-moving');
            if (!moved) {
               setPicked([]);
               openClip(clip.id);
               return;
            }
            if (bars) shiftPicked(bars);
         },
      });
   }

   /**
    * マーカーを横に動かす。動かさずに離したら(click で)メニューを出す。
    * 区間にクリップがあれば、マーカーだけ動かすか、クリップごと動かすかを尋ねる
    */
   function dragMarker(down, marker, flag) {
      const row = flag.closest('.arr-markers');
      let bar = marker.bar;
      const taken = (n) => data.markers.some((m) => m.id !== marker.id && m.bar === n);
      drag(down, {
         onMove: (e) => {
            bar = barAt(row, e.clientX);
            flag.style.setProperty('--start', String(bar));
            flag.classList.add('is-moving');
            flag.classList.toggle('is-invalid', taken(bar));
         },
         onEnd: (moved) => {
            if (!moved) return;
            if (bar === marker.bar || taken(bar)) {
               render();
               return;
            }
            const clips = markerClips(data.clips, data.markers, marker.id);
            if (!clips.length) {
               runPlaced(actions.updateMarker(projectId, marker.id, { bar }));
               return;
            }
            run(moveMarkerDialog(marker, bar, clips));
         },
      });
   }

   // 区間にクリップのあるマーカーを動かすとき、クリップも一緒に動かすかを尋ねる。
   // マーカーだけ動かすと、区間から外れたクリップは無所属になる(連動タスクがボードから消える)ので、セクションごと動かしたいときはクリップごと。
   // 尋ねている間、旗は離した位置に残しておく。キャンセルなら元の位置に描き直す
   async function moveMarkerDialog(marker, bar, clips) {
      const name = data.lanes.find((l) => l.id === marker.laneId)?.name ?? '';
      const selection = { clipIds: clips.map((c) => c.id), markerIds: [marker.id] };
      const canMoveAll = canShiftSelection(data.clips, data.markers, selection, bar - marker.bar);
      const choice = await choiceDialog({
         title: `「${name}」のマーカーを動かす`,
         message: `${marker.bar}小節目から${bar}小節目へ動かします。この区間にはクリップが${clips.length}件あります。`,
         choices: [
            {
               value: 'all',
               label: `クリップごと動かす(${clips.length}件)`,
               primary: true,
               disabled: !canMoveAll,
               note: canMoveAll ? null : 'ほかのクリップと重なるか、1小節目より前に出るので、クリップごとは動かせません。',
            },
            {
               value: 'marker',
               label: 'マーカーだけ動かす',
               note: '区間から外れたクリップは、ほかの区間に入らなければ無所属になり、ボードに出なくなります。',
            },
         ],
      });
      if (choice === 'all') await runPlaced(actions.shiftSelection(projectId, selection, bar - marker.bar));
      else if (choice === 'marker') await runPlaced(actions.updateMarker(projectId, marker.id, { bar }));
      else render();
   }

   /** 転調の旗を横に動かす。1小節目のものは動かせない(押すとメニューだけ) */
   function dragScale(down, scale, flag) {
      if (scale.bar === 1) return;
      const row = flag.closest('.arr-markers');
      let bar = scale.bar;
      const taken = (n) => projectScales(data.project).some((s) => s.bar !== scale.bar && s.bar === n);
      drag(down, {
         onMove: (e) => {
            bar = barAt(row, e.clientX);
            flag.style.setProperty('--start', String(bar));
            flag.classList.add('is-moving');
            flag.classList.toggle('is-invalid', taken(bar));
         },
         onEnd: (moved) => {
            if (!moved) return;
            if (bar === scale.bar || taken(bar)) {
               render();
               return;
            }
            runPlaced(actions.moveScale(projectId, scale.bar, bar));
         },
      });
   }

   // ---- メニューとダイアログ ----

   // まだマーカーを置いていないセクション(1つのセクションにマーカーは1つだけ)
   const unusedSections = () => sections().filter((l) => !data.markers.some((m) => m.laneId === l.id));

   function openMarkerMenu(marker, lane, anchor) {
      openMenu(anchor, [
         ...unusedSections().map((l) => ({
            label: `「${l.name}」に変える`,
            onSelect: () => run(actions.updateMarker(projectId, marker.id, { laneId: l.id })),
         })),
         {
            label: 'マーカーを削除',
            danger: true,
            onSelect: () => run(actions.deleteMarker(projectId, marker.id).then((deleted) => showToast(
               `${deleted.bar}小節目の「${lane?.name ?? ''}」を削除しました`,
               { actionLabel: '元に戻す', onAction: () => run(actions.restoreMarker(deleted)) },
            ))),
         },
      ]);
   }

   function openSlotMenu(bar, anchor) {
      const list = unusedSections();
      const empty = sections().length
         ? 'すべてのセクションをマーカーに使っています(1つのセクションに1つだけ)'
         : 'ボードにセクションを追加すると、マーカーに使えます';
      openMenu(anchor, list.length
         ? list.map((lane) => ({ label: lane.name, onSelect: () => run(actions.addMarker(projectId, lane.id, bar)) }))
         : [{ label: empty, onSelect: () => {} }]);
   }

   // ---- 描画 ----

   // 再生・停止、BPM、音源、全体の書き出し
   function transport() {
      const { project } = data;
      const playing = sound.isPlaying();
      const source = sound.soundSource();
      return h('div', { class: 'arr-transport' },
         h('button', {
            type: 'button',
            class: `btn btn-icon arr-play${playing ? ' is-playing' : ''}`,
            title: `${playing ? '停止' : `${startLabel()}から再生`}(スペースキー)`,
            'aria-label': playing ? '停止' : '再生',
            dataset: { focusKey: 'transport-play' },
            onclick: () => togglePlayback(),
         }, icon(playing ? 'square' : 'play')),
         h('label', { class: 'arr-bpm muted' }, 'BPM', h('input', {
            class: 'input',
            type: 'number',
            min: String(MIN_BPM),
            max: String(MAX_BPM),
            step: '1',
            value: String(projectBpm(project)),
            dataset: { focusKey: 'bpm' },
            onchange: (e) => run(actions.updateProject(projectId, { bpm: e.target.value })),
         })),
         source === null
            ? h('a', { class: 'arr-source is-missing', href: '#/settings', title: '再生に使う音源を設定画面で選ぶ' }, icon('triangle-alert', 14), '音源を設定')
            : source && h('span', { class: 'arr-source muted', title: `音源: ${source.name}(設定画面で変更)` },
               icon('audio-waveform', 14), source.name, sound.isSynthLoading() && '(読み込み中)'),
         h('button', {
            type: 'button',
            class: 'btn btn-icon',
            title: 'アレンジ全体を書き出す',
            'aria-label': 'アレンジ全体を書き出す',
            onclick: (e) => openMenu(e.currentTarget, [
               { label: '.mid で書き出す', onSelect: () => downloadMidi(arrangementMidi(project, data.tracks, data.clips)) },
               { label: '.wav で書き出す', onSelect: () => { exportAudio(); } },
            ]),
         }, icon('download')));
   }

   // アレンジ全体を、音源で鳴らした音(WAV)で書き出す。書き出している間は、もう一度押しても始めない
   let exporting = false;
   async function exportAudio() {
      if (exporting) return;
      exporting = true;
      const { project } = data;
      // 進み具合で出し直すたびに閉じる関数が変わるので、最後のものを持つ
      let close = showProgress('WAV を書き出しています');
      try {
         const blob = await renderWav(data, (progress) => {
            close = showProgress(`WAV を書き出しています(${Math.floor(progress * 100)}%)`);
         });
         downloadBlob(blob, audioFileName(project.title));
      } catch (error) {
         reportPlayError(error);
      } finally {
         close();
         exporting = false;
      }
   }

   function toolbar() {
      const { project } = data;
      return h('div', { class: 'board-toolbar' },
         projectHead({ project, tasks: data.tasks, run }),
         projectTabs(projectId, 'arrange'),
         transport(),
         idle.el,
         h('span', { class: 'muted board-summary' }, `トラック${data.tracks.length}・クリップ${data.clips.length}`));
   }

   // ルーラー。押した小節が、再生を始める位置になる(再生中なら、そこから鳴らし直す)
   function rulerRow() {
      const ruler = h('div', {
         class: 'arr-ruler',
         title: '押した小節から再生します',
         onclick: (e) => seek((barAt(ruler, e.clientX) - 1) * TICKS_PER_BAR),
      },
      Array.from({ length: data.bars }, (_, i) => h('span', {
         // 4小節ごとに強調する(4/4 で16小節や8小節のまとまりを数えやすくする)
         class: `arr-bar-num${i % 4 === 0 ? ' is-strong' : ''}`,
         'aria-hidden': 'true',
      }, String(i + 1))),
      h('span', { class: 'arr-cursor', style: { '--start': String(1 + startTick / TICKS_PER_BAR) }, 'aria-hidden': 'true' }));
      return h('div', { class: 'arr-row arr-ruler-row' }, h('div', { class: 'arr-corner arr-ruler-corner' }, clearMixButton()), ruler);
   }

   // 全トラックのミュート・ソロを外すボタン。トラック名の列の上(ルーラーの左の角)に置く。
   // ミュート・ソロのボタンと同じく、押すとすぐに音と表示を変え、裏で保存する
   function clearMixButton() {
      const mixed = data.tracks.filter((t) => t.mute || t.solo);
      return h('button', {
         type: 'button',
         class: 'arr-clear-mix',
         title: '全トラックのミュート・ソロを解除',
         disabled: !mixed.length,
         dataset: { focusKey: 'clear-mix' },
         onclick: () => {
            for (const t of mixed) setLocalTrack(t.id, { mute: false, solo: false });
            render();
            saveLocal(actions.clearTrackMix(projectId));
         },
      }, icon('volume-2', 12), 'ミュート・ソロ解除');
   }

   // クリップの中に、ノートの並びを小さく出す(高さは、クリップの中のいちばん低い音〜高い音に合わせる)
   function notePreview(clip) {
      const notes = audibleNotes(clip);
      if (!notes.length) return null;
      const pitches = notes.map((n) => n.pitch);
      const low = Math.min(...pitches);
      const high = Math.max(...pitches);
      const span = Math.max(12, high - low + 1);
      const top = high + Math.floor((span - (high - low + 1)) / 2);
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'clip-notes');
      svg.setAttribute('viewBox', `0 0 ${clipTicks(clip)} ${span}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('aria-hidden', 'true');
      for (const n of notes) {
         const rect = document.createElementNS(SVG_NS, 'rect');
         rect.setAttribute('x', String(n.start));
         rect.setAttribute('y', String(top - n.pitch + 0.1));
         rect.setAttribute('width', String(n.length));
         rect.setAttribute('height', '0.8');
         svg.append(rect);
      }
      return svg;
   }

   // マーカーの段。下には小節ごとの透明なボタン(押すとその小節にマーカーを置く)を敷き、
   // その上に、区間の色帯(押せない)と、マーカーの旗(押すとメニュー、横にドラッグで移動)を重ねる。
   function markerRow(spans, colors) {
      const slots = Array.from({ length: data.bars }, (_, i) => h('button', {
         type: 'button',
         class: 'arr-slot',
         style: { '--start': String(i + 1) },
         title: `${i + 1}小節目にマーカーを置く`,
         'aria-label': `${i + 1}小節目にマーカーを置く`,
         dataset: { focusKey: `slot:${i + 1}` },
         onclick: (e) => openSlotMenu(i + 1, e.currentTarget),
      }));
      const bands = spans.map(({ marker, lane, from, to }) => h('div', {
         class: 'arr-band',
         style: { '--start': String(from), '--len': String(to - from + 1), '--lane-color': colors.get(marker.laneId) ?? 'var(--border)' },
      }));
      const flags = spans.map(({ marker, lane, from, to }) => {
         const flag = h('button', {
            type: 'button',
            class: 'arr-flag',
            style: { '--start': String(from), '--len': String(to - from + 1), '--lane-color': colors.get(marker.laneId) ?? 'var(--border)' },
            title: `${lane?.name ?? ''}(${from}小節目から)ドラッグで移動`,
            dataset: { focusKey: `marker:${marker.id}` },
            onpointerdown: (e) => dragMarker(e, marker, flag),
            onclick: (e) => {
               if (suppressClick) return;
               openMarkerMenu(marker, lane, e.currentTarget);
            },
         }, lane?.name ?? '');
         return flag;
      });
      return h('div', { class: 'arr-row arr-marker-row arr-section-row' },
         h('div', { class: 'arr-corner arr-corner-label' }, 'セクション'),
         h('div', { class: 'arr-markers' }, slots, bands, flags));
   }

   // スケールの段。作りはマーカーの段と同じ(小節のボタンの上に、区間の帯と旗を重ねる)。
   // 小節を押すと、そこで転調する。1小節目の旗は曲の頭のスケールなので、動かせず消せない
   function scaleRow() {
      const scales = projectScales(data.project).filter((s) => s.bar <= data.bars);
      const spans = scales.map((scale, i) => ({ scale, from: scale.bar, to: (scales[i + 1]?.bar ?? data.bars + 1) - 1 }));
      const slots = Array.from({ length: data.bars }, (_, i) => h('button', {
         type: 'button',
         class: 'arr-slot',
         style: { '--start': String(i + 1) },
         title: `${i + 1}小節目で転調する`,
         'aria-label': `${i + 1}小節目で転調する`,
         dataset: { focusKey: `scale-slot:${i + 1}` },
         onclick: () => run(scaleDialog(data.project, i + 1, `${i + 1}小節目で転調`)),
      }));
      const style = (from, to) => ({ '--start': String(from), '--len': String(to - from + 1), '--lane-color': 'var(--text-muted)' });
      const bands = spans.map(({ from, to }) => h('div', { class: 'arr-band', style: style(from, to) }));
      const flags = spans.map(({ scale, from, to }) => {
         const flag = h('button', {
            type: 'button',
            class: `arr-flag${scale.bar === 1 ? ' is-fixed' : ''}`,
            style: style(from, to),
            title: `${scaleLabel(scale)}(${from}小節目から)${scale.bar === 1 ? '' : 'ドラッグで移動'}`,
            dataset: { focusKey: `scale:${scale.bar}` },
            onpointerdown: (e) => dragScale(e, scale, flag),
            onclick: (e) => {
               if (suppressClick) return;
               openScaleMenu(data.project, scale, e.currentTarget);
            },
         }, scaleLabel(scale));
         return flag;
      });
      return h('div', { class: 'arr-row arr-marker-row arr-scale-row' },
         h('div', { class: 'arr-corner arr-corner-label' }, 'スケール'),
         h('div', { class: 'arr-markers' }, slots, bands, flags));
   }

   function clipElement(clip) {
      // マーカーを動かしたり消したりして、どのセクションにも入らなくなったクリップ。ボードには出ていない
      const outside = clipSection(clip, data.markers) === null;
      // 色は連動タスクのステータスに合わせる(ボードのタスクと同じ配色)。無所属の間は点線のまま
      const status = outside ? null : data.tasks.find((t) => t.clipId === clip.id)?.status;
      const preview = notePreview(clip);
      return h('div', {
         class: `clip${clip.name ? '' : ' is-untitled'}${outside ? ' is-outside' : ''}${status === 'doing' || status === 'done' ? ` is-${status}` : ''}${picked.has(clip.id) ? ' is-picked' : ''}`,
         style: { '--start': String(clip.startBar), '--len': String(clip.bars) },
         dataset: { clipId: clip.id, focusKey: `clip:${clip.id}` },
         tabIndex: 0,
         role: 'button',
         title: `${clip.name || UNTITLED_CLIP} ${barRange(clip)}${outside ? '(セクションの外。ボードには出ません)' : ''}${clip.memo ? `\n${clip.memo}` : ''}`,
         'aria-label': `${clip.name || UNTITLED_CLIP} ${barRange(clip)}${outside ? '(セクションの外)' : ''}`,
         // スペースは再生・停止に使うので、開くのは Enter だけ
         onkeydown: (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            openClip(clip.id);
         },
      },
      preview,
      h('span', { class: 'clip-edge is-start', dataset: { edge: 'start' }, title: 'ドラッグで長さを変える' }),
      h('span', { class: 'clip-name' }, clip.name || UNTITLED_CLIP),
      clip.memo && icon('notebook-text', 12),
      h('span', { class: 'clip-edge is-end', dataset: { edge: 'end' }, title: 'ドラッグで長さを変える' }));
   }

   // index はトラックの並び順(0 始まり)。見出しに番号として出す(保存はしない)
   function trackRow(track, index, boundaries, audible) {
      const menuButton = h('button', {
         type: 'button',
         class: 'btn btn-icon',
         'aria-label': `${track.name}のメニュー`,
         dataset: { focusKey: `track-menu:${track.id}` },
         onclick: () => openMenu(menuButton, [
            { label: '名前を変更', onSelect: () => run(renameTrackDialog(projectId, track)) },
            { label: '削除', danger: true, onSelect: () => run(deleteTrackDialog(projectId, track, data)) },
         ]),
      }, icon('ellipsis-vertical'));

      const clips = data.clips.filter((c) => c.trackId === track.id);
      const lane = h('div', {
         class: 'arr-lane',
         dataset: { trackId: track.id },
         onpointerdown: (e) => {
            if (e.button === 0 && (e.ctrlKey || e.metaKey)) {
               marqueeClips(e);
               return;
            }
            const clipEl = e.target.closest('.clip');
            const edge = e.target.closest('.clip-edge')?.dataset.edge ?? 'move';
            const clip = clipEl && data.clips.find((c) => c.id === clipEl.dataset.clipId);
            // 選んだものの1つを掴んだら、まとめて横に動かす。それ以外を押したら、選択を外す
            if (clip && edge === 'move' && picked.size > 1 && picked.has(clip.id)) {
               dragPicked(e, clip);
               return;
            }
            if (e.button === 0 && picked.size) setPicked([]);
            if (!clip) {
               dragCreate(e, track);
               return;
            }
            dragClip(e, clip, edge);
         },
         // タッチの長押しでクリップを掴んでいる間は、ブラウザのメニューを出さない
         oncontextmenu: (e) => {
            if (dragging) e.preventDefault();
         },
         // クリップのダブルクリックでピアノロールを開く。空いているところなら、1小節のクリップを作る
         ondblclick: (e) => {
            // ポインタを捕まえていたので、イベントの対象はレーンになる。押した位置の要素で見分ける
            const under = document.elementFromPoint(e.clientX, e.clientY);
            const clipEl = under?.closest('.clip');
            if (clipEl) {
               if (!under.closest('.clip-edge')) openPianoRoll(clipEl.dataset.clipId);
               return;
            }
            if (needMarker()) return;
            const place = { trackId: track.id, startBar: barAt(lane, e.clientX), bars: 1 };
            if (placeable(place)) createClip(track, place);
         },
      },
      // セクションの境目の線(押せない)
      boundaries.map((bar) => h('div', { class: 'arr-boundary', style: { '--start': String(bar) } })),
      clips.map(clipElement));

      const { mute, solo, reverb } = trackMix(track);
      return h('div', { class: `arr-row arr-track${audible.has(track.id) ? '' : ' is-silent'}`, dataset: { trackId: track.id } },
         h('div', { class: 'arr-head', title: 'ドラッグで並べ替え' },
            // 番号とつまみのアイコンは同じ場所に重ね、ホバーしたらアイコンに切り替える(CSS)
            h('span', { class: 'arr-head-grip', title: `${index + 1}番目のトラック` },
               h('span', { class: 'arr-head-num' }, String(index + 1)),
               icon('grip-vertical', 14)),
            h('span', { class: 'arr-head-text' },
               h('span', { class: 'arr-head-top' },
                  h('span', { class: 'arr-head-name', title: track.name }, track.name),
                  mixButton(track, 'mute', mute),
                  mixButton(track, 'solo', solo),
                  menuButton),
               h('span', { class: 'arr-head-bottom' },
                  h('button', {
                     type: 'button',
                     class: 'arr-head-sound',
                     title: `${soundLabel(track)}(押すと音色を変える)`,
                     dataset: { focusKey: `track-sound:${track.id}` },
                     onclick: () => run(trackSoundDialog(projectId, track, data.tracks)),
                  }, soundLabel(track)),
                  soundKnob(track, 'volume'),
                  soundKnob(track, 'pan'),
                  mixButton(track, 'reverb', reverb)))),
         lane);
   }

   // 音量・パンのつまみ。ミュート・ソロと同じく、動かしている間はすぐ音に効かせ、離したら裏で保存する。
   // 動かしている間は再描画を待たせる(作り直すと、掴んでいるつまみが消える)
   function soundKnob(track, key) {
      const sound = trackSound(track);
      const isPan = key === 'pan';
      return knob({
         value: sound[key],
         reset: isPan ? CENTER_PAN : DEFAULT_VOLUME,
         bipolar: isPan,
         label: `${track.name}の${isPan ? 'パン' : '音量'}`,
         format: isPan ? panLabel : String,
         focusKey: `${key}:${track.id}`,
         onInput: (value) => setLocalTrack(track.id, { [key]: value }),
         onChange: (value) => saveLocal(actions.updateTrackSound(projectId, track.id, { [key]: value })),
         onDragStart: () => {
            dragging = true;
         },
         onDragEnd: () => {
            dragging = false;
            if (renderPending) {
               renderPending = false;
               render();
            }
         },
      });
   }

   const MIX_BUTTONS = {
      mute: { label: 'ミュート', title: 'ミュート(再生で鳴らさない)', icon: 'volume-x' },
      solo: { label: 'ソロ', title: 'ソロ(ソロのトラックだけを鳴らす)', icon: 'headphones' },
      reverb: { label: 'リバーブ', title: 'リバーブ(再生でリバーブを掛ける)', icon: 'reverb' },
   };

   // ミュート・ソロ・リバーブのボタン。押すとすぐに音と表示を変え、裏で保存する
   function mixButton(track, key, on) {
      const { label, title, icon: name } = MIX_BUTTONS[key];
      return h('button', {
         type: 'button',
         class: `btn btn-icon arr-mix-toggle is-${key}${on ? ' is-on' : ''}`,
         title,
         'aria-label': `${track.name}の${label}`,
         'aria-pressed': String(on),
         dataset: { focusKey: `${key}:${track.id}` },
         onclick: () => {
            const patch = { [key]: !on };
            setLocalTrack(track.id, patch);
            render();
            saveLocal(actions.updateTrackMix(projectId, track.id, patch));
         },
      }, icon(name, 14));
   }

   function setupSortable() {
      sortable?.destroy();
      sortable = createSortable(root.querySelector('.arr-tracks'), {
         draggable: '.arr-track',
         handle: '.arr-head',
         filter: 'button',
         preventOnFilter: false,
         onEnd: ({ item, oldIndex, newIndex }) => {
            if (oldIndex === newIndex) return;
            run(actions.moveTrack(projectId, item.dataset.trackId, domIndex(item, '.arr-track')));
         },
      });
   }

   // トラック名の列の幅を、いちばん長い名前に合わせる。短ければ HEAD_MIN のまま、長くても全角 HEAD_NAME_CHARS 文字ぶんまで
   // (それより長い名前は … で切る)。スマホ幅では CSS の幅のまま(画面が狭いので広げない)
   const measure = document.createElement('canvas').getContext('2d');
   const wide = matchMedia('(min-width: 721px)');
   const onWideChange = () => fitHeadWidth();
   wide.addEventListener('change', onWideChange);
   function fitHeadWidth() {
      const names = [...root.querySelectorAll('.arr-head-name')];
      if (!names.length || !wide.matches) {
         root.style.removeProperty('--arr-head');
         return;
      }
      const style = getComputedStyle(names[0]);
      measure.font = style.font;
      const head = names[0].closest('.arr-head');
      const others = head.offsetWidth - names[0].clientWidth; // 名前の欄より外(つまみ・ボタン・余白)
      const longest = Math.max(...names.map((el) => measure.measureText(el.textContent).width));
      const limit = HEAD_NAME_CHARS * parseFloat(style.fontSize);
      root.style.setProperty('--arr-head', `${Math.max(HEAD_MIN, Math.ceil(others + Math.min(longest, limit) + 1))}px`);
   }

   // 再描画でスクロール位置が飛ばないように、前後で保存・復元する
   function captureScroll() {
      const scroller = root.querySelector('.arr');
      return { left: scroller?.scrollLeft ?? 0, top: scroller?.scrollTop ?? 0 };
   }

   function restoreScroll(scroll) {
      const scroller = root.querySelector('.arr');
      scroller.scrollLeft = scroll.left;
      scroller.scrollTop = scroll.top;
   }

   function render() {
      if (!data.project) {
         view.replaceChildren(h('div', { class: 'empty' },
            h('p', null, 'プロジェクトが見つかりません。'),
            h('p', null, h('a', { href: '#/' }, 'プロジェクト一覧へ'))));
         return;
      }
      if (dragging) {
         renderPending = true;
         return;
      }
      // 転調の位置も、マーカーと同じく小節数に数える(右の端に置いた転調が見えなくならないように)
      data.bars = arrangementBars(data.clips, [...data.markers, ...projectScales(data.project)]);
      const colors = sectionColors(data.lanes);
      const spans = markerSpans(data.markers, data.lanes, data.bars);
      const boundaries = spans.map((s) => s.from).filter((bar) => bar > 1);
      // ミュートしている(ほかのトラックがソロの)トラックは、クリップを薄く出す
      const audible = audibleTrackIds(data.tracks);
      const scroll = captureScroll();

      root.classList.toggle('is-placing', Boolean(placing));
      keepFocus(view, () => view.replaceChildren(
         toolbar(),
         ...(placing ? [placingBar()] : []),
         h('div', { class: 'arr' },
            h('div', { class: 'arr-inner', style: { '--bars': String(data.bars) } },
               // 再生位置の線。トラック名の列より下に重ねるため、先に置く(follow で動かす)
               h('div', { class: 'arr-playhead', hidden: true, 'aria-hidden': 'true' }),
               rulerRow(),
               // セクションの段はトラックのすぐ上に置く(境目の点線がトラックへ続いて見えるように)
               scaleRow(),
               markerRow(spans, colors),
               h('div', { class: 'arr-tracks' }, data.tracks.map((track, i) => trackRow(track, i, boundaries, audible))),
               h('div', { class: 'arr-row arr-foot' },
                  h('button', {
                     type: 'button',
                     class: 'arr-add',
                     dataset: { focusKey: 'track-add' },
                     onclick: () => run(addTrackDialog(projectId)),
                  }, icon('plus'), 'トラックを追加'),
                  (!data.tracks.length || !data.markers.length) && h('p', { class: 'arr-hint muted' },
                     !data.markers.length && 'クリップは、セクションマーカーの範囲に置きます。先に上の「セクション」の段を押して、マーカーを置いてください。',
                     !data.tracks.length && 'トラックを足したら、空いているところをドラッグ(またはダブルクリック)してクリップを作ります。'))))));
      fitHeadWidth();
      restoreScroll(scroll);
      markSelected();
      setupSortable();
      if (sound.isPlaying()) follow();
   }

   async function refresh() {
      const [project, lanes, tracks, clips, markers, tasks] = await Promise.all([
         repo().getProject(projectId),
         repo().getLanes(projectId),
         repo().getTracks(projectId),
         repo().getClips(projectId),
         repo().getMarkers(projectId),
         repo().getTasks(projectId),
      ]);
      if (!alive) return;
      // tasks は、トラックの削除の確認に出す連動タスクの数と、クリップの色(連動タスクのステータス)に使う
      data = { project, lanes: sortByOrder(lanes), tracks: withLocal(sortByOrder(tracks)), clips, markers, tasks };
      // 消えたクリップは選択から外す
      picked = new Set(clips.filter((c) => picked.has(c.id)).map((c) => c.id));
      render();
      if (!project) return;
      pianoRoll.update(data);
      await syncPlayback();
   }

   const unsubscribe = subscribe(() => run(refresh()));
   run(refresh());
   return () => {
      alive = false;
      unsubscribe();
      idle.destroy();
      unwatchSynth();
      sound.stop();
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeydown);
      document.removeEventListener('keyup', onKeyup);
      wide.removeEventListener('change', onWideChange);
      drawer.destroy();
      pianoRoll.close();
      sortable?.destroy();
   };
}
