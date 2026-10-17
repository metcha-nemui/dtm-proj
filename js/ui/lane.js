// レーン1本分の表示(ヘッダー、タスク一覧、クイック入力)。操作は handlers 経由でボードに渡す。

import { STATUSES, STATUS_LABELS } from '../domain/task.js';
import { h, icon, progressBar } from './components/dom.js';

function taskItem(task, handlers, pending) {
   const next = STATUSES[(STATUSES.indexOf(task.status) + 1) % STATUSES.length];
   // メモは先頭を1行だけ見せる(改行は空白にして詰め、入らない分は CSS で … にする)
   const memo = task.memo.replace(/\s+/g, ' ').trim();

   return h('li', {
      class: `task is-${task.status}${task.clipId ? ' is-linked' : ''}`,
      dataset: task.clipId ? { taskId: task.id, clipId: task.clipId } : { taskId: task.id },
   },
      h('button', {
         type: 'button',
         // 変更を送っている間は、丸を回して待ち時間を伝える
         class: `task-status${pending ? ' is-pending' : ''}`,
         'aria-busy': pending ? 'true' : null,
         title: pending ? '保存中…' : `${STATUS_LABELS[task.status]}(クリックで${STATUS_LABELS[next]}にする)`,
         'aria-label': `${task.title}: ${STATUS_LABELS[task.status]}。クリックで${STATUS_LABELS[next]}にする`,
         dataset: { focusKey: `status:${task.id}` },
         onclick: () => handlers.onCycleStatus(task),
      }, h('span', { class: 'status-mark' }, task.status === 'done' && icon('check', 12, 3))),
      h('button', {
         type: 'button',
         class: 'task-body',
         dataset: { focusKey: `task:${task.id}` },
         onclick: () => handlers.onOpenTask?.(task),
      },
      h('span', { class: 'task-title' },
         task.clipId && h('span', { class: 'task-linked', title: 'アレンジのクリップ' }, icon('audio-lines', 12)),
         task.title),
      memo && h('span', { class: 'task-meta', title: task.memo }, memo)));
}

/**
 * @param {object} props
 * @param {object} props.lane
 * @param {object[]} props.tasks このレーンのタスク(並び順どおり)
 * @param {string|null} props.color セクションの色。「全体」レーンは null(CSS の色を使う)
 * @param {object} props.stats summarize() の結果
 * @param {{ has: (taskId: string) => boolean }} props.pendingStatus ステータスの変更を送っている途中のタスク
 * @param {object} props.handlers onCycleStatus(task) / onOpenTask(task) / onAddTask(lane, title) /
 *   onToggleCollapse(lane) / onMenu(lane, anchor) / onInsertBefore(lane)。
 *   メニューと「前に追加」はセクションにだけ出す(「全体」レーンは名前変更・複製・削除ができない)
 */
export function renderLane({ lane, tasks, color, stats, pendingStatus, handlers }) {
   const input = h('input', {
      class: 'input quick-add-input',
      placeholder: '+ タスクを追加',
      'aria-label': `${lane.name}にタスクを追加`,
      autocomplete: 'off',
      enterkeyhint: 'done',
      dataset: { focusKey: `quick:${lane.id}` },
   });
   const quickAdd = h('form', {
      class: 'quick-add',
      onsubmit: (e) => {
         e.preventDefault();
         const title = input.value.trim();
         if (!title) return;
         // 連続入力できるように、保存を待たずに欄を空ける
         input.value = '';
         handlers.onAddTask(lane, title);
      },
   }, input);

   const menuButton = h('button', {
      type: 'button',
      class: 'btn btn-icon lane-menu',
      'aria-label': `${lane.name}のメニュー`,
      dataset: { focusKey: `menu:${lane.id}` },
      onclick: () => handlers.onMenu(lane, menuButton),
   }, icon('ellipsis-vertical'));

   return h('section', {
      class: `lane lane-${lane.type}${lane.collapsed ? ' is-collapsed' : ''}`,
      id: `lane-${lane.id}`,
      dataset: { laneId: lane.id },
      style: color ? { '--lane-color': color } : null,
   },
   lane.type === 'section' && h('button', {
      type: 'button',
      class: 'lane-insert',
      title: 'ここにセクションを追加',
      'aria-label': `${lane.name}の前にセクションを追加`,
      onclick: () => handlers.onInsertBefore(lane),
   }, icon('plus', 14)),
   h('header', { class: 'lane-header' },
      h('button', {
         type: 'button',
         class: 'btn btn-icon lane-toggle',
         'aria-expanded': String(!lane.collapsed),
         'aria-label': lane.collapsed ? `${lane.name}を開く` : `${lane.name}を折りたたむ`,
         dataset: { focusKey: `toggle:${lane.id}` },
         onclick: () => handlers.onToggleCollapse(lane),
      }, icon(lane.collapsed ? 'chevron-right' : 'chevron-down')),
      h('h2', { class: 'lane-name', title: lane.name }, lane.name),
      h('span', { class: 'lane-count', title: '完了 / 全タスク' }, `${stats.done}/${stats.total}`),
      lane.type === 'section' && menuButton,
      h('div', { class: 'lane-sub' }, progressBar(stats.ratio))),
   h('ul', { class: 'task-list', dataset: { laneId: lane.id } },
      tasks.map((task) => taskItem(task, handlers, pendingStatus.has(task.id)))),
   quickAdd);
}
