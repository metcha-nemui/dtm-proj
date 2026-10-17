// タスク詳細。PCでは右ドロワー、スマホではボトムシートとして出す(見た目の切り替えはCSS)。
// 入力は欄を離れたとき(change)と閉じるときに保存する。
// リファレンス(曲名)の欄は referenceField.js。
// アレンジのクリップから来たタスク(連動タスク)では、名前と詳細はクリップのものを直す(タイトルの「トラック名:」は直せない)。

import * as actions from '../actions.js';
import { UNTITLED_CLIP } from '../domain/arrangement.js';
import { collectReferences } from '../domain/reference.js';
import { STATUSES, STATUS_LABELS, isValidPeriod } from '../domain/task.js';
import { repo, subscribe } from '../state.js';
import { autoGrow, fitTextarea } from './components/autoGrow.js';
import { h, icon } from './components/dom.js';
import { reportError, showToast } from './components/toast.js';
import { barRange } from './clipDrawer.js';
import { createReferenceField } from './referenceField.js';

/**
 * @param {string} projectId
 * @param {{ onSelectionChange?: (taskId: string|null) => void }} [options]
 */
export function createTaskDrawer(projectId, { onSelectionChange } = {}) {
   let task = null; // 表示中のタスク(最後に読み込んだ、または保存した状態)
   let clip = null; // 連動タスクなら、元のクリップ(最後に読み込んだ、または保存した状態)
   let el = null; // ドロワーのDOM。閉じている間は null
   let requested = null; // open() の競合を避けるための、最後に要求されたタスクID
   const run = (promise) => promise.catch(reportError);

   async function loadContext(taskId) {
      const [tasks, lanes, clips, tracks] = await Promise.all([
         repo().getTasks(projectId),
         repo().getLanes(projectId),
         repo().getClips(projectId),
         repo().getTracks(projectId),
      ]);
      const found = tasks.find((t) => t.id === taskId);
      if (!found) return null;
      const linkedClip = found.clipId ? clips.find((c) => c.id === found.clipId) ?? null : null;
      return {
         task: found,
         clip: linkedClip,
         track: linkedClip ? tracks.find((t) => t.id === linkedClip.trackId) ?? null : null,
         lane: lanes.find((l) => l.id === found.laneId) ?? null,
         knownReferences: collectReferences(tasks),
      };
   }

   // 入力欄の内容に変更があれば保存する
   function commit() {
      if (!task || !el) return;
      // 曲名を打ったまま閉じたり欄を離れたりしても、消さずに足す
      el.references.commitPending();
      const patch = {};
      const title = el.title.value.trim();
      if (clip) {
         // 連動タスクの名前と詳細はクリップのもの。クリップ名は空でもよい
         const clipPatch = {};
         if (title !== clip.name) clipPatch.name = title;
         if (el.memo.value !== clip.memo) clipPatch.memo = el.memo.value;
         if (Object.keys(clipPatch).length) saveClip(clipPatch);
      } else {
         if (!title) el.title.value = task.title;
         else if (title !== task.title) patch.title = title;
         if (el.memo.value !== task.memo) patch.memo = el.memo.value;
      }
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
      saveFields(patch);
   }

   // 同じ変更を二度保存しないように、手元の task に先に反映してから保存する。
   // 保存に失敗したら、手元の task を保存前の値に戻す(入力欄は打った内容のまま残し、次に欄を離れたときや閉じるときに保存し直す)
   function saveFields(patch) {
      const before = task;
      task = { ...task, ...patch };
      run(actions.updateTask(projectId, task.id, patch).catch((error) => {
         if (task?.id === before.id) {
            // あとから別の値を保存しようとした項目は、そちらの結果に任せる
            const failed = Object.keys(patch).filter((key) => task[key] === patch[key]);
            task = { ...task, ...Object.fromEntries(failed.map((key) => [key, before[key]])) };
            if ('references' in patch && el) el.references.render();
         }
         throw error;
      }));
   }

   // 連動タスクの名前と詳細を、クリップに保存する(同じ変更を二度保存しないように、手元に先に反映する)
   function saveClip(patch) {
      clip = { ...clip, ...patch };
      run(actions.updateClip(projectId, clip.id, patch));
   }

   const taskReferences = () => task?.references ?? []; // リファレンスを持つ前に作ったタスクには項目がない

   function remove() {
      const { id, title } = task;
      const clipId = clip?.id;
      task = null; // 削除するタスクを閉じるときに保存し直さない
      clip = null;
      close();
      // 連動タスクは、アレンジのクリップごと消す(クリップが残っていると、また作られる)
      const deleting = clipId
         ? actions.deleteClip(projectId, clipId).then((deleted) => ({ deleted, restore: actions.restoreClip }))
         : actions.deleteTask(projectId, id).then((deleted) => ({ deleted, restore: actions.restoreTask }));
      run(deleting.then(({ deleted, restore }) => showToast(`「${title}」を削除しました`, {
         actionLabel: '元に戻す',
         onAction: () => run(restore(deleted)),
      })));
   }

   function build() {
      const field = (label, control) => h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), control);
      const title = h('input', { class: 'input drawer-title', 'aria-label': 'タイトル', autocomplete: 'off', onchange: commit });
      const trackName = h('span', { class: 'drawer-track' });
      const linkedNote = h('p', { class: 'drawer-linked-note' },
         icon('audio-lines', 14),
         'アレンジのクリップから来たタスクです。セクションはアレンジのマーカーで決まります。',
         h('a', { href: `#/p/${projectId}/arrange` }, 'アレンジで見る'));
      const deleteButton = h('button', { type: 'button', class: 'btn btn-danger', onclick: remove }, 'タスクを削除');
      const memo = autoGrow(h('textarea', { class: 'textarea drawer-memo', 'aria-label': 'メモ', placeholder: 'メモ', onchange: commit }));
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
      const references = createReferenceField({
         getReferences: taskReferences,
         onChange: (next) => saveFields({ references: next }),
         onBlur: commit,
      });
      const referenceField = field('リファレンス', references.el);

      const panel = h('aside', { class: 'drawer', role: 'dialog', 'aria-label': 'タスク詳細', tabIndex: -1 },
         h('header', { class: 'drawer-head' },
            laneName,
            h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': '閉じる', onclick: () => close() }, icon('x'))),
         h('div', { class: 'drawer-body' },
            h('div', { class: 'drawer-title-row' }, trackName, title),
            linkedNote,
            statusField,
            h('div', { class: 'drawer-period' }, startField, endField),
            referenceField,
            field('メモ', memo),
            h('div', { class: 'drawer-foot' }, deleteButton)));
      const backdrop = h('div', { class: 'drawer-backdrop', onclick: () => close() });

      document.getElementById('overlay-root').append(backdrop, panel);
      document.body.classList.add('drawer-open');
      el = {
         panel, backdrop, title, trackName, linkedNote, deleteButton,
         memo, statusButtons, statusField, startDate, endDate, startField, endField, laneName, references,
      };
   }

   // 読み込んだ内容を表示に反映する。編集中(フォーカス中)の欄は上書きしない
   function apply(context, { force = false } = {}) {
      task = context.task;
      clip = context.clip;
      const set = (input, value) => {
         if (force || document.activeElement !== input) input.value = value;
      };
      // 連動タスクは、トラック名を固定で出し、その後ろのクリップ名だけを直せるようにする
      set(el.title, clip ? clip.name : task.title);
      set(el.memo, clip ? clip.memo : task.memo);
      el.title.placeholder = clip ? UNTITLED_CLIP : '';
      el.title.setAttribute('aria-label', clip ? 'クリップ名' : 'タイトル');
      el.trackName.hidden = !clip;
      el.trackName.textContent = clip ? `${context.track?.name ?? ''}:` : '';
      el.linkedNote.hidden = !clip;
      el.deleteButton.textContent = clip ? 'クリップごと削除' : 'タスクを削除';
      set(el.startDate, task.startDate ?? '');
      set(el.endDate, task.endDate ?? '');
      for (const button of el.statusButtons) {
         button.setAttribute('aria-pressed', String(button.dataset.status === task.status));
      }
      // 日付は実績で、ステータスを変えたときに自動で入る。ここに出すのは、その修正のための欄。
      // 着手していれば開始日を、完了していれば終了日も直せる
      el.startField.hidden = task.status === 'todo';
      el.endField.hidden = task.status !== 'done';
      el.laneName.textContent = [context.lane?.name, clip && barRange(clip)].filter(Boolean).join('・');
      el.references.setKnown(context.knownReferences);
      el.references.render();
      // 中身と、上の欄(リファレンスのチップ・日付)の高さが変わるので、最後に合わせる
      fitTextarea(el.memo);
   }

   async function open(taskId) {
      commit();
      requested = taskId;
      const context = await loadContext(taskId);
      if (!context || requested !== taskId) return;
      if (!el) build();
      el.references.reset();
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
      clip = null;
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
