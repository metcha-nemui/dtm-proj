// タスク詳細。PCでは右ドロワー、スマホではボトムシートとして出す(見た目の切り替えはCSS)。
// 入力は欄を離れたとき(change)と閉じるときに保存する。
// リファレンス(曲名)は、Enter か候補の選択で1件ずつ足す。候補は同じプロジェクトのタスクに付いている曲名から出す。

import * as actions from '../actions.js';
import { canonicalizeReference, collectReferences, suggestReferences } from '../domain/reference.js';
import { STATUSES, STATUS_LABELS, isValidPeriod } from '../domain/task.js';
import { repo, subscribe } from '../state.js';
import { h, icon } from './components/dom.js';
import { reportError, showToast } from './components/toast.js';

/**
 * @param {string} projectId
 * @param {{ onSelectionChange?: (taskId: string|null) => void }} [options]
 */
const SUGGESTION_LIMIT = 8; // リファレンスの候補を一度に出す数

export function createTaskDrawer(projectId, { onSelectionChange } = {}) {
   let task = null; // 表示中のタスク(最後に読み込んだ、または保存した状態)
   let knownReferences = []; // プロジェクトのタスクに付いている曲名(候補の元)
   let suggestions = []; // 表示中の候補
   let activeSuggestion = -1; // キーボードで選んでいる候補。-1 なら選んでいない
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
      return {
         task: found,
         lane: lanes.find((l) => l.id === found.laneId) ?? null,
         isTemplate: Boolean(project?.isTemplate),
         knownReferences: collectReferences(tasks),
      };
   }

   // 入力欄の内容に変更があれば保存する
   function commit() {
      if (!task || !el) return;
      // 曲名を打ったまま閉じたり欄を離れたりしても、消さずに足す
      if (el.referenceInput.value.trim()) addReference(el.referenceInput.value);
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

   // ---- リファレンス ----

   const references = () => task?.references ?? []; // リファレンスを持つ前に作ったタスクには項目がない

   function saveReferences(next) {
      task = { ...task, references: next }; // 同じ変更を二度保存しないように先に反映しておく
      renderReferences();
      run(actions.updateTask(projectId, task.id, { references: next }));
   }

   // 表記の違いだけなら既存の曲名に揃えてから足す。そのタスクに付いていれば何もしない
   function addReference(name) {
      el.referenceInput.value = '';
      closeSuggestions();
      const canonical = canonicalizeReference(name, [...references(), ...knownReferences]);
      if (!canonical || references().includes(canonical)) return;
      saveReferences([...references(), canonical]);
   }

   function removeReference(name) {
      saveReferences(references().filter((r) => r !== name));
      el.referenceInput.focus();
   }

   function renderReferences() {
      el.referenceList.replaceChildren(...references().map((name) => h('li', { class: 'ref-chip' },
         h('span', { class: 'ref-chip-name' }, name),
         h('button', {
            type: 'button',
            class: 'ref-chip-remove',
            'aria-label': `「${name}」を外す`,
            onclick: () => removeReference(name),
         }, icon('x', 14)))));
      el.referenceList.hidden = !references().length;
   }

   // 入力に合う候補を出す。force なら入力が空でも(↓キーで)出す
   function updateSuggestions({ force = false } = {}) {
      const input = el.referenceInput.value;
      suggestions = input.trim() || force
         ? suggestReferences(input, knownReferences, references()).slice(0, SUGGESTION_LIMIT)
         : [];
      activeSuggestion = -1;
      renderSuggestions();
   }

   function closeSuggestions() {
      suggestions = [];
      activeSuggestion = -1;
      renderSuggestions();
   }

   function renderSuggestions() {
      const list = el.suggestionList;
      list.replaceChildren(...suggestions.map((name, i) => h('li', {
         id: `ref-suggestion-${i}`,
         class: 'ref-suggestion',
         role: 'option',
         'aria-selected': String(i === activeSuggestion),
         // 押した時点で入力欄のフォーカスが外れると、打ちかけの文字が先に足されてしまう
         onmousedown: (e) => e.preventDefault(),
         onclick: () => addReference(name),
      }, name)));
      list.hidden = !suggestions.length;
      el.referenceInput.setAttribute('aria-expanded', String(!list.hidden));
      if (activeSuggestion >= 0) {
         el.referenceInput.setAttribute('aria-activedescendant', `ref-suggestion-${activeSuggestion}`);
         list.children[activeSuggestion].scrollIntoView({ block: 'nearest' });
      } else {
         el.referenceInput.removeAttribute('aria-activedescendant');
      }
   }

   function onReferenceKeydown(e) {
      // 日本語入力の変換を確定する Enter は、曲名の決定に使わない
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
         e.preventDefault();
         if (!suggestions.length) updateSuggestions({ force: true });
         if (!suggestions.length) return;
         // 選択なし(-1)も含めて循環させる
         const step = e.key === 'ArrowDown' ? 1 : -1;
         activeSuggestion = ((activeSuggestion + 1 + step + suggestions.length + 1) % (suggestions.length + 1)) - 1;
         renderSuggestions();
      } else if (e.key === 'Enter') {
         e.preventDefault();
         const name = activeSuggestion >= 0 ? suggestions[activeSuggestion] : el.referenceInput.value;
         if (name.trim()) addReference(name);
      } else if (e.key === 'Escape' && suggestions.length) {
         // 候補だけを閉じ、ドロワーは閉じない
         e.preventDefault();
         closeSuggestions();
      }
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
      const referenceList = h('ul', { class: 'ref-chips', 'aria-label': 'リファレンス' });
      const suggestionList = h('ul', { class: 'ref-suggestions', id: 'ref-suggestions', role: 'listbox', hidden: true });
      const referenceInput = h('input', {
         class: 'input',
         'aria-label': 'リファレンスを追加',
         placeholder: '曲名を入力して Enter',
         autocomplete: 'off',
         role: 'combobox',
         'aria-autocomplete': 'list',
         'aria-controls': 'ref-suggestions',
         'aria-expanded': 'false',
         oninput: () => updateSuggestions(),
         onkeydown: onReferenceKeydown,
         onblur: () => {
            closeSuggestions();
            commit();
         },
      });
      const referenceField = field('リファレンス', h('div', { class: 'ref-field' },
         referenceList,
         h('div', { class: 'ref-input' }, referenceInput, suggestionList)));

      const panel = h('aside', { class: 'drawer', role: 'dialog', 'aria-label': 'タスク詳細', tabIndex: -1 },
         h('header', { class: 'drawer-head' },
            laneName,
            h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': '閉じる', onclick: () => close() }, icon('x'))),
         h('div', { class: 'drawer-body' },
            title,
            statusField,
            h('div', { class: 'drawer-period' }, startField, endField),
            referenceField,
            field('メモ', memo),
            h('div', { class: 'drawer-foot' },
               h('button', { type: 'button', class: 'btn btn-danger', onclick: remove }, 'タスクを削除'))));
      const backdrop = h('div', { class: 'drawer-backdrop', onclick: () => close() });

      document.getElementById('overlay-root').append(backdrop, panel);
      document.body.classList.add('drawer-open');
      el = {
         panel, backdrop, title, memo, statusButtons, statusField, startDate, endDate, startField, endField, laneName,
         referenceField, referenceList, referenceInput, suggestionList,
      };
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
      // リファレンスは曲ごとのもので、テンプレートには持たせない
      el.referenceField.hidden = context.isTemplate;
      knownReferences = context.knownReferences;
      renderReferences();
   }

   async function open(taskId) {
      commit();
      requested = taskId;
      const context = await loadContext(taskId);
      if (!context || requested !== taskId) return;
      if (!el) build();
      el.referenceInput.value = '';
      closeSuggestions();
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
