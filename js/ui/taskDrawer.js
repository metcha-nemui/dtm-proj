// タスク詳細。PCでは右ドロワー、スマホではボトムシートとして出す(見た目の切り替えはCSS)。
// 入力は欄を離れたとき(change)と閉じるときに保存する。

import * as actions from '../actions.js';
import { STATUSES, STATUS_LABELS, isValidPeriod } from '../domain/task.js';
import { repo, subscribe } from '../state.js';
import { h, icon } from './components/dom.js';
import { reportError, showToast } from './components/toast.js';

/**
 * @param {string} projectId
 * @param {{ onSelectionChange?: (taskId: string|null) => void }} [options]
 */
export function createTaskDrawer(projectId, { onSelectionChange } = {}) {
   let task = null; // 表示中のタスク(最後に読み込んだ、または保存した状態)
   let el = null; // ドロワーのDOM。閉じている間は null
   let requested = null; // open() の競合を避けるための、最後に要求されたタスクID
   const run = (promise) => promise.catch(reportError);

   async function loadContext(taskId) {
      const [tasks, lanes, project] = await Promise.all([
         repo().getTasks(projectId),
         repo().getLanes(projectId),
         repo().getProject(projectId),
      ]);
      const found = tasks.find((t) => t.id === taskId);
      if (!found) return null;
      return { task: found, lane: lanes.find((l) => l.id === found.laneId) ?? null, isTemplate: Boolean(project?.isTemplate) };
   }

   // 入力欄の内容に変更があれば保存する
   function commit() {
      if (!task || !el) return;
      const patch = {};
      const title = el.title.value.trim();
      if (!title) el.title.value = task.title;
      else if (title !== task.title) patch.title = title;
      if (el.memo.value !== task.memo) patch.memo = el.memo.value;
      // 日付を持つ前に作ったタスクには項目がないので、null として比べる
      const period = { startDate: task.startDate ?? null, endDate: task.endDate ?? null };
      const startDate = el.startDate.value || null;
      const endDate = el.endDate.value || null;
      if (!isValidPeriod(startDate, endDate)) {
         // 保存せずに、入力を保存済みの値へ戻す
         el.startDate.value = period.startDate ?? '';
         el.endDate.value = period.endDate ?? '';
         reportError(new Error('終了日は開始日以降にしてください'));
      } else {
         if (startDate !== period.startDate) patch.startDate = startDate;
         if (endDate !== period.endDate) patch.endDate = endDate;
      }
      if (!Object.keys(patch).length) return;
      task = { ...task, ...patch }; // 同じ変更を二度保存しないように先に反映しておく
      run(actions.updateTask(projectId, task.id, patch));
   }

   function remove() {
      const { id, title } = task;
      task = null; // 削除するタスクを閉じるときに保存し直さない
      close();
      run(actions.deleteTask(projectId, id).then((deleted) => showToast(`「${title}」を削除しました`, {
         actionLabel: '元に戻す',
         onAction: () => run(actions.restoreTask(deleted)),
      })));
   }

   function build() {
      const field = (label, control) => h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), control);
      const title = h('input', { class: 'input drawer-title', 'aria-label': 'タイトル', autocomplete: 'off', onchange: commit });
      const memo = h('textarea', { class: 'textarea drawer-memo', 'aria-label': 'メモ', placeholder: 'メモ', onchange: commit });
      const statusButtons = STATUSES.map((status) => h('button', {
         type: 'button',
         class: 'segment',
         dataset: { status },
         onclick: () => run(actions.setTaskStatus(projectId, task.id, status)),
      }, STATUS_LABELS[status]));
      const laneName = h('span', { class: 'drawer-lane muted' });
      const statusField = field('ステータス', h('div', { class: 'segments' }, statusButtons));
      const startDate = h('input', { class: 'input', type: 'date', 'aria-label': '開始日', onchange: commit });
      const endDate = h('input', { class: 'input', type: 'date', 'aria-label': '終了日', onchange: commit });
      const startField = field('開始日', startDate);
      const endField = field('終了日', endDate);

      const panel = h('aside', { class: 'drawer', role: 'dialog', 'aria-label': 'タスク詳細', tabIndex: -1 },
         h('header', { class: 'drawer-head' },
            laneName,
            h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': '閉じる', onclick: () => close() }, icon('x'))),
         h('div', { class: 'drawer-body' },
            title,
            statusField,
            h('div', { class: 'drawer-period' }, startField, endField),
            field('メモ', memo),
            h('div', { class: 'drawer-foot' },
               h('button', { type: 'button', class: 'btn btn-danger', onclick: remove }, 'タスクを削除'))));
      const backdrop = h('div', { class: 'drawer-backdrop', onclick: () => close() });

      document.getElementById('overlay-root').append(backdrop, panel);
      document.body.classList.add('drawer-open');
      el = { panel, backdrop, title, memo, statusButtons, statusField, startDate, endDate, startField, endField, laneName };
   }

   // 読み込んだ内容を表示に反映する。編集中(フォーカス中)の欄は上書きしない
   function apply(context, { force = false } = {}) {
      task = context.task;
      const set = (input, value) => {
         if (force || document.activeElement !== input) input.value = value;
      };
      set(el.title, task.title);
      set(el.memo, task.memo);
      set(el.startDate, task.startDate ?? '');
      set(el.endDate, task.endDate ?? '');
      for (const button of el.statusButtons) {
         button.setAttribute('aria-pressed', String(button.dataset.status === task.status));
      }
      // テンプレートはステータスも、開始日・終了日も使わない
      el.statusField.hidden = context.isTemplate;
      // 日付は実績で、ステータスを変えたときに自動で入る。ここに出すのは、その修正のための欄。
      // 着手していれば開始日を、完了していれば終了日も直せる
      el.startField.hidden = context.isTemplate || task.status === 'todo';
      el.endField.hidden = context.isTemplate || task.status !== 'done';
      el.laneName.textContent = context.lane?.name ?? '';
   }

   async function open(taskId) {
      commit();
      requested = taskId;
      const context = await loadContext(taskId);
      if (!context || requested !== taskId) return;
      if (!el) build();
      apply(context, { force: true });
      el.panel.focus({ preventScroll: true });
      onSelectionChange?.(taskId);
   }

   function close() {
      if (!el) return;
      commit();
      const closedId = task?.id;
      el.panel.remove();
      el.backdrop.remove();
      document.body.classList.remove('drawer-open');
      el = null;
      task = null;
      requested = null;
      onSelectionChange?.(null);
      if (closedId) document.querySelector(`[data-focus-key="task:${CSS.escape(closedId)}"]`)?.focus();
   }

   async function resync() {
      if (!task) return;
      const context = await loadContext(task.id);
      if (!task || !el) return;
      if (!context) {
         // 他の操作(レーン削除など)でタスクが消えた
         task = null;
         close();
         return;
      }
      if (context.task.id === task.id) apply(context);
   }

   const onKeydown = (e) => {
      if (e.key !== 'Escape' || !el || e.defaultPrevented) return;
      if (document.querySelector('dialog[open], .menu')) return;
      close();
   };
   document.addEventListener('keydown', onKeydown);
   const unsubscribe = subscribe(() => run(resync()));

   return {
      open: (taskId) => run(open(taskId)),
      close,
      get taskId() {
         return el ? task?.id ?? null : null;
      },
      destroy() {
         close();
         unsubscribe();
         document.removeEventListener('keydown', onKeydown);
      },
   };
}
