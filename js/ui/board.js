// ボード(#/p/:id)。

import * as actions from '../actions.js';
import { sortByOrder } from '../domain/order.js';
import { sectionColors } from '../domain/project.js';
import { summarize } from '../domain/stats.js';
import { repo, subscribe } from '../state.js';
import { confirmDialog, formDialog } from './components/dialog.js';
import { h, icon, keepFocus, progressBar } from './components/dom.js';
import { openMenu } from './components/menu.js';
import { createSortable, domIndex } from './components/sortable.js';
import { reportError, showToast } from './components/toast.js';
import { dueBadge } from './dueBadge.js';
import { renderGantt } from './gantt.js';
import { renderLane } from './lane.js';
import { projectHead } from './projectHeader.js';
import { projectTabs } from './projectTabs.js';
import { createTaskDrawer } from './taskDrawer.js';

// 「未完了のみ」は画面を行き来しても保つ
let hideDone = false;

export function mount(container, { id: projectId }) {
   const root = h('div', { class: 'board-page' });
   container.append(root);

   let alive = true;
   let data = null;
   let sortables = [];
   let revealLaneId = null; // 追加・複製した直後に、画面内へスクロールして見せるレーン
   const run = (promise) => promise.catch(reportError);
   // ドラッグ&ドロップは、SortableJS が先に要素を動かしてから保存する。
   // 失敗したまま放っておくと保存されていない並びが見えたままになるので、保存済みの状態で描き直す
   const runPlaced = (promise) => promise.catch((error) => {
      reportError(error);
      render();
   });

   function markSelected(taskId) {
      for (const el of root.querySelectorAll('.task.is-selected')) el.classList.remove('is-selected');
      if (taskId) root.querySelector(`.task[data-task-id="${CSS.escape(taskId)}"]`)?.classList.add('is-selected');
   }
   const drawer = createTaskDrawer(projectId, { onSelectionChange: markSelected });

   // ステータスの変更を送っている途中のタスク(タスクID → 押したときのステータス)。
   // 通信に時間がかかるので、結果が画面に出るまで丸を回して待ち時間を伝える。
   const pendingStatus = new Map();

   async function cycleStatus(task) {
      if (pendingStatus.has(task.id)) return;
      pendingStatus.set(task.id, task.status);
      root.querySelector(`.task[data-task-id="${CSS.escape(task.id)}"] .task-status`)?.classList.add('is-pending');
      try {
         // 成功したら、新しいステータスを読み込んだ再描画(render)のときに待ち表示を外す
         await actions.cycleTaskStatus(projectId, task.id);
      } catch (error) {
         pendingStatus.delete(task.id);
         render();
         reportError(error);
      }
   }

   const handlers = {
      onOpenTask: (task) => drawer.open(task.id),
      onCycleStatus: (task) => cycleStatus(task),
      onAddTask: (lane, title) => run(actions.addTask(projectId, lane.id, title)),
      onToggleCollapse: (lane) => run(actions.setLaneCollapsed(projectId, lane.id, !lane.collapsed)),
      onInsertBefore: (lane) => run(addSectionDialog(sections().findIndex((l) => l.id === lane.id))),
      onMenu: (lane, anchor) => openMenu(anchor, [
         { label: '名前を変更', onSelect: () => run(renameLaneDialog(lane)) },
         { label: '複製', onSelect: () => run(actions.duplicateLane(projectId, lane.id).then(reveal)) },
         {
            label: lane.collapsed ? '開く' : '折りたたむ',
            onSelect: () => run(actions.setLaneCollapsed(projectId, lane.id, !lane.collapsed)),
         },
         { label: '削除', danger: true, onSelect: () => run(deleteLaneDialog(lane)) },
      ]),
   };

   const sections = () => data.lanes.filter((l) => l.type === 'section');

   function reveal(lane) {
      if (lane) revealLaneId = lane.id;
      const el = revealLaneId && document.getElementById(`lane-${revealLaneId}`);
      if (!el) return;
      revealLaneId = null;
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
   }

   async function addSectionDialog(index) {
      const values = await formDialog({
         title: 'セクションを追加',
         submitLabel: '追加',
         fields: [{ name: 'name', label: '名前(空欄なら「セクション」)', placeholder: '例: 落ちサビ' }],
      });
      if (!values) return;
      reveal(await actions.addSection(projectId, { name: values.name, index }));
   }

   async function renameLaneDialog(lane) {
      const values = await formDialog({
         title: '名前を変更',
         fields: [{ name: 'name', label: '名前', value: lane.name, required: true }],
      });
      if (values) await actions.renameLane(projectId, lane.id, values.name);
   }

   async function deleteLaneDialog(lane) {
      const laneTasks = data.tasks.filter((t) => t.laneId === lane.id);
      const linked = laneTasks.filter((t) => t.clipId).length;
      // アレンジのマーカーはレーンを指しているので、レーンと一緒に消える
      const markers = (await repo().getMarkers(projectId)).filter((m) => m.laneId === lane.id).length;
      const parts = [
         laneTasks.length && `タスク${laneTasks.length}件${linked ? `(アレンジのクリップから来たもの${linked}件を含む)` : ''}`,
         markers && `アレンジのマーカー${markers}件`,
      ].filter(Boolean);
      const ok = await confirmDialog({
         title: `「${lane.name}」を削除`,
         message: parts.length ? `このレーンの${parts.join('と、')}も一緒に削除します。` : 'このレーンを削除します。',
         okLabel: '削除',
         danger: true,
      });
      if (!ok) return;
      const snapshot = await actions.deleteLane(projectId, lane.id);
      showToast(`「${lane.name}」を削除しました`, {
         actionLabel: '元に戻す',
         onAction: () => run(actions.restoreLane(snapshot)),
      });
   }

   // ドラッグ&ドロップ。再描画のたびに付け直す。
   function setupSortables() {
      for (const sortable of sortables) sortable?.destroy();
      sortables = [];

      for (const list of root.querySelectorAll('.task-list')) {
         sortables.push(createSortable(list, {
            group: 'tasks',
            draggable: '.task',
            // 連動タスクのセクションはアレンジで決まるので、レーンの中の並べ替えだけにする
            onMove: ({ dragged, from, to }) => !(dragged.dataset.clipId && from !== to),
            onEnd:({ item, from, to, oldIndex, newIndex }) => {
               if (from === to && oldIndex === newIndex) return;
               // 「未完了のみ」で隠れているタスクも含めたDOM上の位置を使う
               runPlaced(actions.moveTask(projectId, item.dataset.taskId, to.dataset.laneId, domIndex(item, '.task')));
            },
         }));
      }

      // 並べ替えられるのはセクションだけ(「全体」レーンは1本で、左端に固定)
      for (const group of root.querySelectorAll('.lane-group-section')) {
         sortables.push(createSortable(group, {
            draggable: '.lane',
            handle: '.lane-header',
            filter: 'button',
            preventOnFilter: false,
            onEnd: ({ item, oldIndex, newIndex }) => {
               if (oldIndex === newIndex) return;
               runPlaced(actions.moveLane(projectId, item.dataset.laneId, domIndex(item, '.lane')));
            },
         }));
      }
   }

   async function refresh() {
      const [project, lanes, tasks] = await Promise.all([
         repo().getProject(projectId),
         repo().getLanes(projectId),
         repo().getTasks(projectId),
      ]);
      if (!alive) return;
      data = { project, lanes: sortByOrder(lanes), tasks: sortByOrder(tasks) };
      render();
   }

   // 再描画でスクロール位置が飛ばないように、前後で保存・復元する
   function captureScroll() {
      const board = root.querySelector('.board');
      const gantt = root.querySelector('.gantt-scroll');
      return {
         left: board?.scrollLeft ?? 0,
         top: board?.scrollTop ?? 0,
         gantt: gantt && { left: gantt.scrollLeft, top: gantt.scrollTop },
         lists: new Map([...root.querySelectorAll('.task-list')].map((el) => [el.dataset.laneId, el.scrollTop])),
      };
   }

   function restoreScroll(scroll) {
      const board = root.querySelector('.board');
      board.scrollLeft = scroll.left;
      board.scrollTop = scroll.top;
      for (const el of root.querySelectorAll('.task-list')) el.scrollTop = scroll.lists.get(el.dataset.laneId) ?? 0;

      const gantt = root.querySelector('.gantt-scroll');
      if (!gantt) return;
      if (scroll.gantt) {
         gantt.scrollLeft = scroll.gantt.left;
         gantt.scrollTop = scroll.gantt.top;
         return;
      }
      // ガントチャートが出た最初だけ、今日が見える位置(右寄り)に合わせる
      const today = gantt.querySelector('.gantt-day.is-today');
      if (today) gantt.scrollLeft = today.offsetLeft - gantt.clientWidth * 0.7;
   }

   function toolbar() {
      const { project, tasks } = data;
      const stats = summarize(tasks);
      return h('div', { class: 'board-toolbar' },
         projectHead({ project, tasks, run }),
         projectTabs(projectId, 'board'),
         h('div', { class: 'board-progress' },
            progressBar(stats.ratio),
            h('span', { class: 'muted' }, `${stats.done}/${stats.total} 完了`),
            dueBadge(project, stats)),
         h('label', { class: 'board-filter' },
            h('input', {
               type: 'checkbox',
               checked: hideDone,
               dataset: { focusKey: 'filter' },
               onchange: (e) => {
                  hideDone = e.target.checked;
                  root.querySelector('.board').classList.toggle('hide-done', hideDone);
               },
            }),
            '未完了のみ'));
   }

   // チップで選んだレーンを見える位置まで動かす
   function jumpToLane(lane) {
      const el = document.getElementById(`lane-${lane.id}`);
      const board = root.querySelector('.board');
      if (!el) return;
      // スマホではレーンを縦に積んでいて、ページ全体がスクロールする
      if (getComputedStyle(board).flexDirection === 'column') {
         el.scrollIntoView({ behavior: 'smooth', block: 'start' });
         return;
      }
      // PCでは横スクロール。左端に固定している「全体」レーンの下に隠れない位置へ動かす
      const pinned = root.querySelector('.lane-group-global');
      const gap = parseFloat(getComputedStyle(pinned).paddingRight);
      const left = lane.type === 'global'
         ? 0
         : el.getBoundingClientRect().left - board.getBoundingClientRect().left + board.scrollLeft - pinned.offsetWidth - gap;
      board.scrollTo({ left, behavior: 'smooth' });
   }

   // セクション一覧。構成を俯瞰でき、押すとそのレーンへジャンプする
   function laneChips() {
      const colors = sectionColors(data.lanes);
      const ordered = [...data.lanes.filter((l) => l.type === 'global'), ...sections()];
      return h('nav', { class: 'lane-chips', 'aria-label': 'レーンへジャンプ' }, ordered.map((lane) => {
         const stats = summarize(data.tasks.filter((t) => t.laneId === lane.id));
         return h('button', {
            type: 'button',
            class: `lane-chip lane-chip-${lane.type}${stats.total > 0 && stats.done === stats.total ? ' is-finished' : ''}`,
            style: colors.has(lane.id) ? { '--lane-color': colors.get(lane.id) } : null,
            dataset: { focusKey: `chip:${lane.id}` },
            onclick: () => jumpToLane(lane),
         },
         h('span', null, lane.name),
         h('span', { class: 'lane-chip-count' }, `${stats.done}/${stats.total}`));
      }));
   }

   function laneGroup(type) {
      const { lanes, tasks } = data;
      const colors = sectionColors(lanes);
      const group = lanes.filter((l) => l.type === type);
      return h('div', { class: `lane-group lane-group-${type}`, dataset: { laneType: type }, hidden: group.length === 0 },
         group.map((lane) => {
            const laneTasks = tasks.filter((t) => t.laneId === lane.id);
            return renderLane({
               lane,
               tasks: laneTasks,
               color: colors.get(lane.id) ?? null,
               stats: summarize(laneTasks),
               pendingStatus,
               handlers,
            });
         }));
   }

   function render() {
      if (!data.project) {
         root.replaceChildren(h('div', { class: 'empty' },
            h('p', null, 'プロジェクトが見つかりません。'),
            h('p', null, h('a', { href: '#/' }, 'プロジェクト一覧へ'))));
         return;
      }
      // ステータスが変わった(またはタスクが消えた)ものは、待ち表示を終える
      for (const [taskId, statusWhenClicked] of pendingStatus) {
         if (data.tasks.find((t) => t.id === taskId)?.status === statusWhenClicked) continue;
         pendingStatus.delete(taskId);
      }
      const scroll = captureScroll();
      const gantt = renderGantt(data);
      keepFocus(root, () => root.replaceChildren(...[
         toolbar(),
         laneChips(),
         h('div', { class: `board${hideDone ? ' hide-done' : ''}` },
            laneGroup('global'),
            laneGroup('section'),
            h('button', {
               type: 'button',
               class: 'lane-add',
               dataset: { focusKey: 'lane-add' },
               onclick: () => run(addSectionDialog(sections().length)),
            }, icon('plus'), 'セクションを追加')),
         gantt,
      ].filter(Boolean)));
      restoreScroll(scroll);
      markSelected(drawer.taskId);
      setupSortables();
      reveal();
   }

   const unsubscribe = subscribe(() => run(refresh()));
   run(refresh());
   return () => {
      alive = false;
      unsubscribe();
      drawer.destroy();
      for (const sortable of sortables) sortable?.destroy();
   };
}
