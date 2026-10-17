// アレンジ画面(#/p/:id/arrange)。DAW のアレンジ画面のように、トラックを縦に並べ、クリップを小節単位で置く。
// 上端のルーラーの下にセクションマーカーの段がある。マーカーはボードのセクションを指し、名前と色はそちらに従う。
// クリップは、属するセクションのレーンにタスク(連動タスク)として出る。だから、セクションマーカーの範囲の外には
// 新しく置けない(作る・動かす・伸ばす)。マーカーを動かしたり消したりして範囲の外になったクリップは、そのまま残す。
// プロジェクトだけの画面で、テンプレートにはない。
//
// 位置と幅は CSS 変数(--start は1始まりの小節、--len は小節数、--bar は1小節の幅)で決め、計算は CSS に任せる。

import * as actions from '../actions.js';
import { arrangementBars, canPlace, clipEnd, clipSection, markerSpans, UNTITLED_CLIP } from '../domain/arrangement.js';
import { sortByOrder } from '../domain/order.js';
import { sectionColors } from '../domain/project.js';
import { repo, subscribe } from '../state.js';
import { confirmDialog, formDialog } from './components/dialog.js';
import { h, icon, keepFocus } from './components/dom.js';
import { openMenu } from './components/menu.js';
import { createSortable, domIndex } from './components/sortable.js';
import { reportError, showToast } from './components/toast.js';
import { barRange, createClipDrawer } from './clipDrawer.js';
import { projectTabs } from './projectTabs.js';

const DRAG_THRESHOLD = 4; // これより動かなければクリック(詳細を開く・メニューを出す)として扱う(px)

const clamp = (n, min, max) => Math.max(min, Math.min(n, max));

export function mount(container, { id: projectId }) {
   const root = h('div', { class: 'arr-page' });
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

   function markSelected(clipId) {
      for (const el of root.querySelectorAll('.clip.is-selected')) el.classList.remove('is-selected');
      if (clipId) root.querySelector(`.clip[data-clip-id="${CSS.escape(clipId)}"]`)?.classList.add('is-selected');
   }
   const drawer = createClipDrawer(projectId, { onSelectionChange: markSelected });

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
               if (mode === 'move') drawer.open(clip.id);
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

   function openSlotMenu(bar, anchor) {
      const list = sections();
      openMenu(anchor, list.length
         ? list.map((lane) => ({ label: lane.name, onSelect: () => run(actions.addMarker(projectId, lane.id, bar)) }))
         : [{ label: 'ボードにセクションを追加すると、マーカーに使えます', onSelect: () => {} }]);
   }

   // ---- 描画 ----

   function toolbar() {
      const { project } = data;
      return h('div', { class: 'board-toolbar' },
         h('a', { class: 'btn btn-icon', href: '#/', 'aria-label': 'プロジェクト一覧へ', title: 'プロジェクト一覧へ' }, icon('arrow-left')),
         h('h1', { class: 'board-title', title: project.memo || null }, project.title),
         projectTabs(projectId, 'arrange'),
         h('span', { class: 'muted board-summary' }, `トラック${data.tracks.length}・クリップ${data.clips.length}`));
   }

   function rulerRow() {
      return h('div', { class: 'arr-row arr-ruler-row' },
         h('div', { class: 'arr-corner' }),
         h('div', { class: 'arr-ruler', 'aria-hidden': 'true' }, Array.from({ length: data.bars }, (_, i) => h('span', {
            // 4小節ごとに強調する(4/4 で16小節や8小節のまとまりを数えやすくする)
            class: `arr-bar-num${i % 4 === 0 ? ' is-strong' : ''}`,
         }, String(i + 1)))));
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

   function clipElement(clip) {
      // マーカーを動かしたり消したりして、どのセクションにも入らなくなったクリップ。ボードには出ていない
      const outside = clipSection(clip, data.markers) === null;
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
            drawer.open(clip.id);
         },
      },
      h('span', { class: 'clip-edge is-start', dataset: { edge: 'start' }, title: 'ドラッグで長さを変える' }),
      h('span', { class: 'clip-name' }, clip.name || UNTITLED_CLIP),
      clip.memo && icon('notebook-text', 12),
      h('span', { class: 'clip-edge is-end', dataset: { edge: 'end' }, title: 'ドラッグで長さを変える' }));
   }

   function trackRow(track, boundaries) {
      const menuButton = h('button', {
         type: 'button',
         class: 'btn btn-icon',
         'aria-label': `${track.name}のメニュー`,
         dataset: { focusKey: `track-menu:${track.id}` },
         onclick: () => openMenu(menuButton, [
            { label: '名前を変更', onSelect: () => run(renameTrackDialog(track)) },
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
         // 空いているところのダブルクリックで、1小節のクリップを作る
         ondblclick: (e) => {
            if (e.target.closest('.clip')) return;
            if (needMarker()) return;
            const place = { trackId: track.id, startBar: barAt(lane, e.clientX), bars: 1 };
            if (placeable(place)) createClip(track, place);
         },
      },
      // セクションの境目の線(押せない)
      boundaries.map((bar) => h('div', { class: 'arr-boundary', style: { '--start': String(bar) } })),
      clips.map(clipElement));

      return h('div', { class: 'arr-row arr-track', dataset: { trackId: track.id } },
         h('div', { class: 'arr-head', title: 'ドラッグで並べ替え' },
            icon('grip-vertical', 14),
            h('span', { class: 'arr-head-name', title: track.name }, track.name),
            menuButton),
         lane);
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
         root.replaceChildren(h('div', { class: 'empty' },
            h('p', null, data.project ? 'テンプレートにはアレンジはありません。' : 'プロジェクトが見つかりません。'),
            h('p', null, h('a', { href: '#/' }, 'プロジェクト一覧へ'))));
         return;
      }
      if (dragging) {
         renderPending = true;
         return;
      }
      data.bars = arrangementBars(data.clips, data.markers);
      const colors = sectionColors(data.lanes);
      const spans = markerSpans(data.markers, data.lanes, data.bars);
      const boundaries = spans.map((s) => s.from).filter((bar) => bar > 1);
      const scroll = captureScroll();

      keepFocus(root, () => root.replaceChildren(
         toolbar(),
         h('div', { class: 'arr' },
            h('div', { class: 'arr-inner', style: { '--bars': String(data.bars) } },
               rulerRow(),
               markerRow(spans, colors),
               h('div', { class: 'arr-tracks' }, data.tracks.map((track) => trackRow(track, boundaries))),
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
      markSelected(drawer.clipId);
      setupSortable();
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
      data = { project, lanes: sortByOrder(lanes), tracks: sortByOrder(tracks), clips, markers, tasks };
      render();
   }

   const unsubscribe = subscribe(() => run(refresh()));
   run(refresh());
   return () => {
      alive = false;
      unsubscribe();
      drawer.destroy();
      sortable?.destroy();
   };
}
