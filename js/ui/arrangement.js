// アレンジ画面(#/p/:id/arrange)。DAW のアレンジ画面のように、トラックを縦に並べ、クリップを小節単位で置く。
// 上端のルーラーの下にセクションマーカーの段と、スケール(転調)の段がある。マーカーはボードのセクションを指し、名前と色はそちらに従う。
// クリップは、属するセクションのレーンにタスク(連動タスク)として出る。だから、セクションマーカーの範囲の外には
// 新しく置けない(作る・動かす・伸ばす)。マーカーを動かしたり消したりして範囲の外になったクリップは、そのまま残す。
// プロジェクトだけの画面で、テンプレートにはない。
//
// 位置と幅は CSS 変数(--start は1始まりの小節、--len は小節数、--bar は1小節の幅)で決め、計算は CSS に任せる。
//
// クリップは MIDI クリップでもある。ダブルクリックで下にピアノロールを開き、ツールバーから OS の MIDI 音源で全体を再生する。
// ピアノロールのパネルは再描画で作り直さない(編集中の状態を持っているため)。作り直すのは view の中だけ。

import * as actions from '../actions.js';
import { arrangementBars, canPlace, clipEnd, clipSection, markerSpans, UNTITLED_CLIP } from '../domain/arrangement.js';
import {
   audibleNotes, audibleTrackIds, CENTER_PAN, clipTicks, DEFAULT_VOLUME, GM_PROGRAMS, KEY_NAMES, MAX_BPM, MIN_BPM, noteEvents,
   projectBpm, projectScales, scaleAt, scaleLabel, SCALE_MODES, setupMessages, soundLabel, TICKS_PER_BAR, trackChannels, trackMix,
   trackSound,
} from '../domain/midi.js';
import { sortByOrder } from '../domain/order.js';
import { sectionColors } from '../domain/project.js';
import { repo, subscribe } from '../state.js';
import { confirmDialog, formDialog } from './components/dialog.js';
import { h, icon, keepFocus } from './components/dom.js';
import { openMenu } from './components/menu.js';
import { createSortable, domIndex } from './components/sortable.js';
import { reportError, showToast } from './components/toast.js';
import { barRange, createClipDrawer } from './clipDrawer.js';
import { arrangementMidi, downloadMidi } from './midiExport.js';
import * as sound from './synth.js';
import { createPianoRoll } from './pianoRoll.js';
import { projectTabs } from './projectTabs.js';

const DRAG_THRESHOLD = 4; // これより動かなければクリック(詳細を開く・メニューを出す)として扱う(px)
const SVG_NS = 'http://www.w3.org/2000/svg';

const clamp = (n, min, max) => Math.max(min, Math.min(n, max));

export function mount(container, { id: projectId }) {
   const root = h('div', { class: 'arr-page' });
   const view = h('div', { class: 'arr-view' });
   container.append(root);

   let alive = true;
   let data = null;
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
   const drawer = createClipDrawer(projectId, {
      onSelectionChange: () => markSelected(),
      onOpenPianoRoll: (clipId) => openPianoRoll(clipId),
   });
   const pianoRoll = createPianoRoll({
      projectId,
      onSelectionChange: () => markSelected(),
      // 編集中のクリップのトラックは、ミュートしていても(ほかのトラックがソロでも)鳴らす
      onPlayClip: (clip) => startPlayback((clip.startBar - 1) * TICKS_PER_BAR, clip.trackId).catch(reportPlayError),
      onOpenDetail: (clipId) => drawer.open(clipId),
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
   // 再生を始める位置(小節)は、ルーラーを押して決める。止めても動かない

   let startBar = 1;
   let played = null; // 再生中の中身(playbackInput)。変わったら syncPlayback で差し替える
   let alwaysTrackId = null; // ミュート・ソロに関わらず鳴らすトラック(ピアノロールから再生したとき)
   let frame = null;

   function playbackInput() {
      const channels = trackChannels(data.tracks);
      const audible = audibleTrackIds(data.tracks, alwaysTrackId);
      // ミュートしたトラックの音も、終わりの位置には数える(全部ミュートしても、曲の終わりまで再生位置を進める)
      const all = noteEvents({ tracks: data.tracks, clips: data.clips });
      return {
         bpm: projectBpm(data.project),
         setup: data.tracks.flatMap((t) => setupMessages(t, channels.get(t.id))),
         events: noteEvents({ tracks: data.tracks, clips: data.clips.filter((c) => audible.has(c.trackId)) }),
         endTick: all.at(-1)?.tick ?? 0,
      };
   }

   async function startPlayback(fromTick, alwaysId = null) {
      alwaysTrackId = alwaysId;
      const input = playbackInput();
      played = input;
      await sound.play({ ...input, fromTick: Math.max(0, fromTick) });
      follow();
   }

   // 再生中に中身(ミュート・ソロ、音色・音量・パン、ノート)が変わったら、止めずに差し替える(伸びている音を途切れさせない)。
   // BPM が変わったときだけは、時刻の計算が変わるので、いまの位置から鳴らし直す
   async function syncPlayback() {
      if (!sound.isPlaying() || !played) return;
      const input = playbackInput();
      if (input.bpm !== played.bpm) {
         await startPlayback(sound.playbackTick() ?? 0, alwaysTrackId);
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

   // 保存を待たずに、手元のトラックを変えておく(スライダーやミュートを、すぐ音に効かせる)。
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
      else startPlayback((startBar - 1) * TICKS_PER_BAR).catch(reportPlayError);
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
   });
   // 音源の読み込み(数MB〜数十MB)には時間が掛かるので、画面を開いたときに裏で始めておく。
   // 選ばれていなければ、再生を押したときに知らせる
   sound.prepareSynth().catch(() => {});

   // スペースキーで再生・停止(入力欄やボタン、クリップの上では、そちらの操作を優先する)
   const onKeydown = (e) => {
      if (e.code !== 'Space' || e.repeat || e.defaultPrevented) return;
      if (e.target.closest?.('input, textarea, select, button, [contenteditable], .clip')) return;
      if (document.querySelector('dialog[open]') || !data?.project || data.project.isTemplate) return;
      e.preventDefault();
      togglePlayback();
   };
   document.addEventListener('keydown', onKeydown);

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
    */
   function drag(down, { onMove, onEnd }) {
      if (down.button !== 0) return;
      down.preventDefault(); // ドラッグ中に文字が選択されないようにする
      const target = down.currentTarget;
      target.setPointerCapture(down.pointerId);
      let moved = false;
      dragging = true;
      const move = (e) => {
         if (!moved && Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < DRAG_THRESHOLD) return;
         moved = true;
         onMove(e);
      };
      const end = (e) => {
         target.removeEventListener('pointermove', move);
         target.removeEventListener('pointerup', end);
         target.removeEventListener('pointercancel', end);
         dragging = false;
         const dragged = moved && e.type === 'pointerup';
         if (moved) {
            suppressClick = true;
            setTimeout(() => { suppressClick = false; });
         }
         onEnd(dragged);
         if (renderPending) {
            renderPending = false;
            render();
         }
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', end);
      target.addEventListener('pointercancel', end);
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

   /** マーカーを横に動かす。動かさずに離したら(click で)メニューを出す */
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
            runPlaced(actions.updateMarker(projectId, marker.id, { bar }));
         },
      });
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

   async function addTrackDialog() {
      const values = await formDialog({
         title: 'トラックを追加',
         submitLabel: '追加',
         fields: [{ name: 'name', label: '名前(空欄なら「トラック」)', placeholder: '例: ドラム' }],
      });
      if (!values) return;
      const track = await actions.addTrack(projectId, values.name);
      // 足したトラックを見える位置へ
      document.querySelector(`.arr-track[data-track-id="${CSS.escape(track.id)}"]`)?.scrollIntoView({ block: 'nearest' });
   }

   async function renameTrackDialog(track) {
      const values = await formDialog({
         title: '名前を変更',
         fields: [{ name: 'name', label: '名前', value: track.name, required: true }],
      });
      if (values) await actions.renameTrack(projectId, track.id, values.name);
   }

   async function trackSoundDialog(track) {
      const sound = trackSound(track);
      const values = await formDialog({
         title: `「${track.name}」の音`,
         message: 'OS の MIDI 音源(General MIDI)の音色で鳴らします。',
         fields: [
            {
               name: 'program', label: '音色', type: 'select', value: String(sound.program),
               options: GM_PROGRAMS.map((name, i) => ({ value: String(i), label: `${i + 1}. ${name}` })),
            },
            { name: 'drum', label: 'ドラム(10ch で鳴らす。音色は使わない)', type: 'checkbox', value: sound.drum },
            { name: 'volume', label: '音量(0〜127)', type: 'number', value: String(sound.volume) },
            { name: 'pan', label: 'パン(0 = 左、64 = 中央、127 = 右)', type: 'number', value: String(sound.pan) },
         ],
      });
      if (!values) return;
      // 空欄は元のまま
      const number = (value, fallback) => (String(value).trim() === '' ? fallback : Number(value));
      await actions.updateTrackSound(projectId, track.id, {
         program: Number(values.program),
         drum: values.drum,
         volume: number(values.volume, sound.volume),
         pan: number(values.pan, sound.pan),
      });
   }

   async function deleteTrackDialog(track) {
      const clipIds = new Set(data.clips.filter((c) => c.trackId === track.id).map((c) => c.id));
      // ボードに出ている連動タスクの数(範囲の外のクリップのものは、ボードに出ていないので数えない)
      const tasks = data.tasks.filter((t) => clipIds.has(t.clipId) && t.laneId).length;
      const parts = [clipIds.size && `クリップ${clipIds.size}件`, tasks && `ボードのタスク${tasks}件`].filter(Boolean);
      const ok = await confirmDialog({
         title: `「${track.name}」を削除`,
         message: parts.length ? `このトラックの${parts.join('と、')}も一緒に削除します。` : 'このトラックを削除します。',
         okLabel: '削除',
         danger: true,
      });
      if (!ok) return;
      const snapshot = await actions.deleteTrack(projectId, track.id);
      showToast(`「${track.name}」を削除しました`, {
         actionLabel: '元に戻す',
         onAction: () => run(actions.restoreTrack(snapshot)),
      });
   }

   function openMarkerMenu(marker, lane, anchor) {
      openMenu(anchor, [
         ...sections().filter((l) => l.id !== marker.laneId).map((l) => ({
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

   // スケールを選ぶダイアログ。初期値は、その小節でいま効いているスケール
   async function scaleDialog(bar, title) {
      const current = scaleAt(projectScales(data.project), bar);
      const values = await formDialog({
         title,
         message: 'ピアノロールの行の塗り分けに使います。次の転調まで続きます。',
         fields: [
            {
               name: 'root', label: 'キー', type: 'select', value: String(current.root),
               options: KEY_NAMES.map((name, i) => ({ value: String(i), label: name })),
            },
            { name: 'mode', label: 'メジャー / マイナー', type: 'select', value: current.mode, options: SCALE_MODES },
         ],
      });
      if (values) await actions.setScale(projectId, bar, { root: Number(values.root), mode: values.mode });
   }

   function openScaleMenu(scale, anchor) {
      openMenu(anchor, [
         { label: 'スケールを変更…', onSelect: () => run(scaleDialog(scale.bar, `${scale.bar}小節目のスケール`)) },
         scale.bar > 1 && {
            label: '転調を削除',
            danger: true,
            onSelect: () => run(actions.deleteScale(projectId, scale.bar).then((deleted) => showToast(
               `${deleted.bar}小節目の転調(${scaleLabel(deleted)})を削除しました`,
               { actionLabel: '元に戻す', onAction: () => run(actions.setScale(projectId, deleted.bar, deleted)) },
            ))),
         },
      ].filter(Boolean));
   }

   function openSlotMenu(bar, anchor) {
      const list = sections();
      openMenu(anchor, list.length
         ? list.map((lane) => ({ label: lane.name, onSelect: () => run(actions.addMarker(projectId, lane.id, bar)) }))
         : [{ label: 'ボードにセクションを追加すると、マーカーに使えます', onSelect: () => {} }]);
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
            title: `${playing ? '停止' : `${startBar}小節目から再生`}(スペースキー)`,
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
            title: 'アレンジ全体を .mid で書き出す',
            'aria-label': 'アレンジ全体を .mid で書き出す',
            onclick: () => downloadMidi(arrangementMidi(project, data.tracks, data.clips)),
         }, icon('download')));
   }

   function toolbar() {
      const { project } = data;
      return h('div', { class: 'board-toolbar' },
         h('a', { class: 'btn btn-icon', href: '#/', 'aria-label': 'プロジェクト一覧へ', title: 'プロジェクト一覧へ' }, icon('arrow-left')),
         h('h1', { class: 'board-title', title: project.memo || null }, project.title),
         projectTabs(projectId, 'arrange'),
         transport(),
         h('span', { class: 'muted board-summary' }, `トラック${data.tracks.length}・クリップ${data.clips.length}`));
   }

   // ルーラー。押した小節が、再生を始める位置になる(再生中なら、そこから鳴らし直す)
   function rulerRow() {
      const ruler = h('div', {
         class: 'arr-ruler',
         title: '押した小節から再生します',
         onclick: (e) => {
            startBar = barAt(ruler, e.clientX);
            if (sound.isPlaying()) startPlayback((startBar - 1) * TICKS_PER_BAR).catch(reportPlayError);
            render();
         },
      },
      Array.from({ length: data.bars }, (_, i) => h('span', {
         // 4小節ごとに強調する(4/4 で16小節や8小節のまとまりを数えやすくする)
         class: `arr-bar-num${i % 4 === 0 ? ' is-strong' : ''}`,
         'aria-hidden': 'true',
      }, String(i + 1))),
      h('span', { class: 'arr-cursor', style: { '--start': String(startBar) }, 'aria-hidden': 'true' }));
      return h('div', { class: 'arr-row arr-ruler-row' }, h('div', { class: 'arr-corner' }), ruler);
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
      return h('div', { class: 'arr-row arr-marker-row' },
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
         onclick: () => run(scaleDialog(i + 1, `${i + 1}小節目で転調`)),
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
               openScaleMenu(scale, e.currentTarget);
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
      const preview = notePreview(clip);
      return h('div', {
         class: `clip${clip.name ? '' : ' is-untitled'}${outside ? ' is-outside' : ''}`,
         style: { '--start': String(clip.startBar), '--len': String(clip.bars) },
         dataset: { clipId: clip.id, focusKey: `clip:${clip.id}` },
         tabIndex: 0,
         role: 'button',
         title: `${clip.name || UNTITLED_CLIP} ${barRange(clip)}${outside ? '(セクションの外。ボードには出ません)' : ''}${clip.memo ? `\n${clip.memo}` : ''}`,
         'aria-label': `${clip.name || UNTITLED_CLIP} ${barRange(clip)}${outside ? '(セクションの外)' : ''}`,
         onkeydown: (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
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

   function trackRow(track, boundaries, audible) {
      const menuButton = h('button', {
         type: 'button',
         class: 'btn btn-icon',
         'aria-label': `${track.name}のメニュー`,
         dataset: { focusKey: `track-menu:${track.id}` },
         onclick: () => openMenu(menuButton, [
            { label: '名前を変更', onSelect: () => run(renameTrackDialog(track)) },
            { label: '音色・音量・パン', onSelect: () => run(trackSoundDialog(track)) },
            { label: '削除', danger: true, onSelect: () => run(deleteTrackDialog(track)) },
         ]),
      }, icon('ellipsis-vertical'));

      const clips = data.clips.filter((c) => c.trackId === track.id);
      const lane = h('div', {
         class: 'arr-lane',
         dataset: { trackId: track.id },
         onpointerdown: (e) => {
            const clipEl = e.target.closest('.clip');
            if (!clipEl) {
               dragCreate(e, track);
               return;
            }
            const clip = data.clips.find((c) => c.id === clipEl.dataset.clipId);
            if (clip) dragClip(e, clip, e.target.closest('.clip-edge')?.dataset.edge ?? 'move');
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

      const { mute, solo } = trackMix(track);
      return h('div', { class: `arr-row arr-track${audible.has(track.id) ? '' : ' is-silent'}`, dataset: { trackId: track.id } },
         h('div', { class: 'arr-head', title: 'ドラッグで並べ替え' },
            icon('grip-vertical', 14),
            h('span', { class: 'arr-head-text' },
               h('span', { class: 'arr-head-top' },
                  h('span', { class: 'arr-head-name', title: track.name }, track.name),
                  mixButton(track, 'mute', mute),
                  mixButton(track, 'solo', solo),
                  menuButton),
               h('button', {
                  type: 'button',
                  class: 'arr-head-sound',
                  title: `${soundLabel(track)}(押すと音色・音量・パンを変える)`,
                  dataset: { focusKey: `track-sound:${track.id}` },
                  onclick: () => run(trackSoundDialog(track)),
               }, soundLabel(track)),
               h('span', { class: 'arr-mix' }, mixSlider(track, 'volume'), mixSlider(track, 'pan')))),
         lane);
   }

   // ミュート・ソロのボタン。押すとすぐに音と表示を変え、裏で保存する
   function mixButton(track, key, on) {
      const label = key === 'mute' ? 'ミュート' : 'ソロ';
      return h('button', {
         type: 'button',
         class: `btn btn-icon arr-mix-toggle is-${key}${on ? ' is-on' : ''}`,
         title: key === 'mute' ? 'ミュート(再生で鳴らさない)' : 'ソロ(ソロのトラックだけを鳴らす)',
         'aria-label': `${track.name}の${label}`,
         'aria-pressed': String(on),
         dataset: { focusKey: `${key}:${track.id}` },
         onclick: () => {
            const patch = { [key]: !on };
            setLocalTrack(track.id, patch);
            render();
            saveLocal(actions.updateTrackMix(projectId, track.id, patch));
         },
      }, icon(key === 'mute' ? 'volume-x' : 'headphones', 14));
   }

   // 音量・パンの横スライダーと、値の入力欄。どちらで変えても、もう一方に映す。
   // 動かしている間は手元の値と音だけを変え、離したとき(入力欄は確定したとき)に保存する。ダブルクリックで既定値に戻す
   function mixSlider(track, kind) {
      const isVolume = kind === 'volume';
      const label = isVolume ? '音量' : 'パン';
      const fallback = isVolume ? DEFAULT_VOLUME : CENTER_PAN;
      const value = trackSound(track)[kind];
      const hint = isVolume ? '音量(0〜127)' : 'パン(0 = 左、64 = 中央、127 = 右)';
      const save = (v) => saveLocal(actions.updateTrackSound(projectId, track.id, { [kind]: v }));
      const setValue = (v) => {
         slider.value = String(v);
         number.value = String(v);
         setLocalTrack(track.id, { [kind]: v });
      };
      const slider = h('input', {
         type: 'range',
         class: 'arr-slider',
         min: '0',
         max: '127',
         step: '1',
         value: String(value),
         title: `${hint}。ダブルクリックで ${fallback} に戻す`,
         'aria-label': `${track.name}の${label}`,
         dataset: { focusKey: `${kind}:${track.id}` },
         oninput: () => setValue(Number(slider.value)),
         onchange: () => save(Number(slider.value)),
         ondblclick: () => {
            setValue(fallback);
            save(fallback);
         },
      });
      const number = h('input', {
         type: 'number',
         class: 'arr-mix-number',
         min: '0',
         max: '127',
         step: '1',
         value: String(value),
         title: hint,
         'aria-label': `${track.name}の${label}(数値)`,
         dataset: { focusKey: `${kind}-number:${track.id}` },
         onchange: () => {
            // 空欄は元のまま。範囲の外は端に寄せてから保存する
            const v = number.value.trim() === '' ? Number(slider.value) : trackSound({ [kind]: number.value })[kind];
            setValue(v);
            save(v);
         },
         onkeydown: (e) => {
            if (e.key === 'Enter') number.blur();
         },
      });
      return h('span', { class: `arr-mix-item is-${kind}` },
         h('span', { class: 'arr-mix-icon', title: label }, icon(isVolume ? 'volume-2' : 'arrow-left-right', 12)),
         slider,
         number);
   }

   function setupSortable() {
      sortable?.destroy();
      sortable = createSortable(root.querySelector('.arr-tracks'), {
         draggable: '.arr-track',
         handle: '.arr-head',
         filter: 'button, input',
         preventOnFilter: false,
         onEnd: ({ item, oldIndex, newIndex }) => {
            if (oldIndex === newIndex) return;
            run(actions.moveTrack(projectId, item.dataset.trackId, domIndex(item, '.arr-track')));
         },
      });
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
      if (!data.project || data.project.isTemplate) {
         view.replaceChildren(h('div', { class: 'empty' },
            h('p', null, data.project ? 'テンプレートにはアレンジはありません。' : 'プロジェクトが見つかりません。'),
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

      keepFocus(view, () => view.replaceChildren(
         toolbar(),
         h('div', { class: 'arr' },
            h('div', { class: 'arr-inner', style: { '--bars': String(data.bars) } },
               // 再生位置の線。トラック名の列より下に重ねるため、先に置く(follow で動かす)
               h('div', { class: 'arr-playhead', hidden: true, 'aria-hidden': 'true' }),
               rulerRow(),
               markerRow(spans, colors),
               scaleRow(),
               h('div', { class: 'arr-tracks' }, data.tracks.map((track) => trackRow(track, boundaries, audible))),
               h('div', { class: 'arr-row arr-foot' },
                  h('button', {
                     type: 'button',
                     class: 'arr-add',
                     dataset: { focusKey: 'track-add' },
                     onclick: () => run(addTrackDialog()),
                  }, icon('plus'), 'トラックを追加'),
                  (!data.tracks.length || !data.markers.length) && h('p', { class: 'arr-hint muted' },
                     !data.markers.length && 'クリップは、セクションマーカーの範囲に置きます。先に上の「セクション」の段を押して、マーカーを置いてください。',
                     !data.tracks.length && 'トラックを足したら、空いているところをドラッグ(またはダブルクリック)してクリップを作ります。'))))));
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
      // tasks はトラックの削除の確認に、連動タスクの数を出すためだけに使う
      data = { project, lanes: sortByOrder(lanes), tracks: withLocal(sortByOrder(tracks)), clips, markers, tasks };
      render();
      if (!project || project.isTemplate) return;
      pianoRoll.update(data);
      await syncPlayback();
   }

   const unsubscribe = subscribe(() => run(refresh()));
   run(refresh());
   return () => {
      alive = false;
      unsubscribe();
      unwatchSynth();
      sound.stop();
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeydown);
      drawer.destroy();
      pianoRoll.close();
      sortable?.destroy();
   };
}
