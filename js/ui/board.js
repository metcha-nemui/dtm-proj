// ボード。プロジェクト(#/p/:id)と、テンプレートの編集(#/t/:id)の両方に使う。

import * as actions from '../actions.js';
import { sortByOrder } from '../domain/order.js';
import { listReferences } from '../domain/reference.js';
import { sectionColors } from '../domain/project.js';
import { summarize } from '../domain/stats.js';
import { repo, subscribe } from '../state.js';
import { confirmDialog, formDialog, viewDialog } from './components/dialog.js';
import { h, icon, keepFocus, progressBar } from './components/dom.js';
import { openMenu } from './components/menu.js';
import { createSortable, domIndex } from './components/sortable.js';
import { reportError, showToast } from './components/toast.js';
import { dueBadge } from './dueBadge.js';
import { renderGantt } from './gantt.js';
import { renderLane } from './lane.js';
import { deleteProjectDialog, editProjectDialog, newProjectDialog } from './projectDialogs.js';
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

   // 取り込み元の候補。すべてのテンプレートのセクション(編集中のテンプレート自身は除く。複製で足せるため)
   async function importCandidates() {
      const templates = (await repo().getTemplates())
         .filter((t) => t.id !== projectId)
         .sort((a, b) => a.title.localeCompare(b.title, 'ja'));
      const lanes = await Promise.all(templates.map((t) => repo().getLanes(t.id)));
      return templates.flatMap((template, i) => sortByOrder(lanes[i].filter((l) => l.type === 'section'))
         .map((lane) => ({ label: `${template.title} / ${lane.name}`, from: { projectId: template.id, laneId: lane.id } })));
   }

   async function addSectionDialog(index) {
      const candidates = await importCandidates();
      const values = await formDialog({
         title: 'セクションを追加',
         submitLabel: '追加',
         fields: [
            {
               name: 'source',
               label: '取り込み元',
               type: 'select',
               value: '',
               options: [
                  { value: '', label: '(空のセクション)' },
                  ...candidates.map((c, i) => ({ value: String(i), label: c.label })),
               ],
            },
            { name: 'name', label: '名前(空欄なら、取り込み元の名前か「セクション」)', placeholder: '例: 落ちサビ' },
         ],
      });
      if (!values) return;
      const from = values.source === '' ? null : candidates[Number(values.source)].from;
      reveal(await actions.addSection(projectId, { name: values.name, index, from }));
   }

   async function saveAsTemplateDialog() {
      const values = await formDialog({
         title: 'テンプレートとして保存',
         message: 'いまのセクションとタスクを丸ごとコピーして、新しいテンプレートを作ります。ステータスは引き継ぎません。',
         fields: [{ name: 'name', label: 'テンプレートの名前', value: data.project.title, required: true }],
      });
      if (!values) return;
      const template = await actions.saveProjectAsTemplate(projectId, values.name);
      showToast(`テンプレート「${template.title}」を作りました`, {
         actionLabel: '開く',
         onAction: () => { location.hash = `#/t/${template.id}`; },
      });
   }

   async function createFromTemplate() {
      const project = await newProjectDialog(projectId);
      if (project) location.hash = `#/p/${project.id}`;
   }

   async function duplicateTemplate() {
      const copy = await actions.duplicateTemplate(projectId);
      location.hash = `#/t/${copy.id}`;
   }

   async function renameLaneDialog(lane) {
      const values = await formDialog({
         title: '名前を変更',
         fields: [{ name: 'name', label: '名前', value: lane.name, required: true }],
      });
      if (values) await actions.renameLane(projectId, lane.id, values.name);
   }

   async function deleteLaneDialog(lane) {
      const count = data.tasks.filter((t) => t.laneId === lane.id).length;
      // アレンジのマーカーはレーンを指しているので、レーンと一緒に消える
      const markers = (await repo().getMarkers(projectId)).filter((m) => m.laneId === lane.id).length;
      const parts = [count && `タスク${count}件`, markers && `アレンジのマーカー${markers}件`].filter(Boolean);
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
            onEnd: ({ item, from, to, oldIndex, newIndex }) => {
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

   // プロジェクトのタスクに付いているリファレンスの曲名を、名前順に見せる。見るだけで、どのタスクのものかは出さない
   function showReferences() {
      const names = listReferences(data.tasks);
      return viewDialog({
         title: names.length ? `リファレンス(${names.length}曲)` : 'リファレンス',
         body: names.length
            ? h('ul', { class: 'ref-dialog-list' }, names.map((name) => h('li', null, name)))
            : h('p', { class: 'dialog-message muted' }, 'まだありません。タスク詳細で曲名を付けると、ここに並びます。'),
      });
   }

   function toolbar() {
      const { project, tasks } = data;
      const stats = summarize(tasks);
      // テンプレートはステータスを使わないので、進捗・締切・「未完了のみ」は出さない
      const isTemplate = Boolean(project.isTemplate);
      const listHref = isTemplate ? '#/templates' : '#/';
      const listLabel = isTemplate ? 'テンプレート一覧へ' : 'プロジェクト一覧へ';
      const remove = () => run(deleteProjectDialog(project).then((deleted) => { if (deleted) location.hash = listHref; }));
      const menuButton = h('button', {
         type: 'button',
         class: 'btn btn-icon',
         'aria-label': isTemplate ? 'テンプレートのメニュー' : 'プロジェクトのメニュー',
         dataset: { focusKey: 'project-menu' },
         onclick: () => openMenu(menuButton, isTemplate ? [
            { label: '名前・メモを編集', onSelect: () => run(editProjectDialog(project)) },
            { label: '複製', onSelect: () => run(duplicateTemplate()) },
            { label: 'このテンプレートでプロジェクトを作成', onSelect: () => run(createFromTemplate()) },
            { label: 'テンプレートを削除', danger: true, onSelect: remove },
         ] : [
            { label: '名前・締切・メモを編集', onSelect: () => run(editProjectDialog(project)) },
            { label: 'テンプレートとして保存', onSelect: () => run(saveAsTemplateDialog()) },
            { label: 'プロジェクトを削除', danger: true, onSelect: remove },
         ]),
      }, icon('ellipsis-vertical'));

      const head = [
         h('a', { class: 'btn btn-icon', href: listHref, 'aria-label': listLabel, title: listLabel }, icon('arrow-left')),
         h('h1', { class: 'board-title', title: project.memo || null }, project.title),
         // テンプレートはリファレンスを持たない
         !isTemplate && h('button', {
            type: 'button',
            class: 'btn btn-icon',
            'aria-label': 'リファレンスの一覧',
            title: 'リファレンスの一覧',
            dataset: { focusKey: 'references' },
            onclick: () => run(showReferences()),
         }, icon('music')),
         menuButton,
      ];
      if (isTemplate) {
         return h('div', { class: 'board-toolbar' },
            head,
            h('span', { class: 'board-kind' }, icon('layout-template', 14), 'テンプレート'),
            h('span', { class: 'muted board-summary' }, `セクション${sections().length}・タスク${tasks.length}`));
      }

      return h('div', { class: 'board-toolbar' },
         head,
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
            class: `lane-chip lane-chip-${lane.type}${!data.project.isTemplate && stats.total > 0 && stats.done === stats.total ? ' is-finished' : ''}`,
            style: colors.has(lane.id) ? { '--lane-color': colors.get(lane.id) } : null,
            dataset: { focusKey: `chip:${lane.id}` },
            onclick: () => jumpToLane(lane),
         },
         h('span', null, lane.name),
         h('span', { class: 'lane-chip-count' }, data.project.isTemplate ? String(stats.total) : `${stats.done}/${stats.total}`));
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
               isTemplate: Boolean(data.project.isTemplate),
               pendingStatus,
               handlers,
            });
         }));
   }

   function render() {
      if (!data.project) {
         root.replaceChildren(h('div', { class: 'empty' },
            h('p', null, 'プロジェクト(またはテンプレート)が見つかりません。'),
            h('p', null, h('a', { href: '#/' }, 'プロジェクト一覧へ'), ' / ', h('a', { href: '#/templates' }, 'テンプレート一覧へ'))));
         return;
      }
      const isTemplate = Boolean(data.project.isTemplate);
      // ステータスが変わった(またはタスクが消えた)ものは、待ち表示を終える
      for (const [taskId, statusWhenClicked] of pendingStatus) {
         if (data.tasks.find((t) => t.id === taskId)?.status === statusWhenClicked) continue;
         pendingStatus.delete(taskId);
      }
      const scroll = captureScroll();
      // テンプレートは日付を使わないので、ガントチャートは出さない
      const gantt = isTemplate ? null : renderGantt(data);
      keepFocus(root, () => root.replaceChildren(...[
         toolbar(),
         laneChips(),
         h('div', { class: `board${hideDone && !isTemplate ? ' hide-done' : ''}` },
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
