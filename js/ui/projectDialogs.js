// プロジェクトの作成・編集・削除のダイアログ。一覧とボードの両方から使う。

import * as actions from '../actions.js';
import { sortByOrder } from '../domain/order.js';
import { repo } from '../state.js';
import { confirmDialog, formDialog } from './components/dialog.js';
import { showToast } from './components/toast.js';

/** @returns {Promise<object|null>} 作成したプロジェクト */
export async function newProjectDialog() {
   const { templates } = await repo().getLibrary();
   const sorted = sortByOrder(templates);
   const values = await formDialog({
      title: '新規プロジェクト',
      submitLabel: '作成',
      fields: [
         { name: 'title', label: 'タイトル', placeholder: '曲名(仮でOK)', required: true },
         { name: 'dueDate', label: '締切(任意)', type: 'date' },
         {
            name: 'templateId',
            label: 'テンプレート',
            type: 'select',
            value: sorted[0]?.id,
            options: [...sorted.map((s) => ({ value: s.id, label: s.name })), { value: '', label: '(テンプレートなし)' }],
         },
      ],
   });
   return values && actions.createProject(values);
}

export async function editProjectDialog(project) {
   const values = await formDialog({
      title: 'プロジェクトを編集',
      fields: [
         { name: 'title', label: 'タイトル', value: project.title, required: true },
         { name: 'dueDate', label: '締切(空欄なら締切なし)', type: 'date', value: project.dueDate ?? '' },
         { name: 'memo', label: 'メモ', type: 'textarea', value: project.memo },
      ],
   });
   if (values) await actions.updateProject(project.id, values);
}

/** @returns {Promise<boolean>} 削除したら true */
export async function deleteProjectDialog(project) {
   const ok = await confirmDialog({
      title: 'プロジェクトを削除',
      message: `「${project.title}」を、セクションとタスクごと削除します。元に戻せません。`,
      okLabel: '削除',
      danger: true,
   });
   if (!ok) return false;
   await actions.deleteProject(project.id);
   showToast(`「${project.title}」を削除しました`);
   return true;
}
