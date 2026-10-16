// プロジェクトとテンプレートの作成・編集・削除のダイアログ。一覧とボードの両方から使う。
// テンプレートは「ステータスを使わないプロジェクト」なので、編集と削除は同じダイアログを文言だけ変えて使う。

import * as actions from '../actions.js';
import { repo } from '../state.js';
import { confirmDialog, formDialog } from './components/dialog.js';
import { showToast } from './components/toast.js';

/**
 * @param {string} [templateId] 最初に選んでおくテンプレート
 * @returns {Promise<object|null>} 作成したプロジェクト
 */
export async function newProjectDialog(templateId) {
   const templates = (await repo().getTemplates()).sort((a, b) => a.title.localeCompare(b.title, 'ja'));
   const values = await formDialog({
      title: '新規プロジェクト',
      submitLabel: '作成',
      fields: [
         // 曲名は作り始めの時点では決まっていないことが多いので、空欄でも作れる(「無題のプロジェクト」になる)
         { name: 'title', label: 'タイトル', placeholder: '曲名(空欄なら「無題のプロジェクト」)' },
         { name: 'dueDate', label: '締切(任意)', type: 'date' },
         {
            name: 'templateId',
            label: 'テンプレート',
            type: 'select',
            // テンプレートのボードから開いたときだけそのテンプレートを選んでおく。それ以外は意図しない取り込みを避けて「なし」から始める
            value: templateId ?? '',
            options: [{ value: '', label: '(テンプレートなし)' }, ...templates.map((t) => ({ value: t.id, label: t.title }))],
         },
         { name: 'memo', label: 'メモ(任意)', type: 'textarea' },
      ],
   });
   return values && actions.createProject(values);
}

/** @returns {Promise<object|null>} 作成したテンプレート */
export async function newTemplateDialog() {
   const values = await formDialog({
      title: '新規テンプレート',
      submitLabel: '作成',
      fields: [{ name: 'name', label: '名前', placeholder: '例: クラブミュージック', required: true }],
   });
   return values && actions.createTemplate(values);
}

export async function editProjectDialog(project) {
   const values = await formDialog({
      title: project.isTemplate ? 'テンプレートを編集' : 'プロジェクトを編集',
      fields: [
         { name: 'title', label: project.isTemplate ? '名前' : 'タイトル', value: project.title, required: true },
         // テンプレートに締切はない
         !project.isTemplate && { name: 'dueDate', label: '締切(空欄なら締切なし)', type: 'date', value: project.dueDate ?? '' },
         { name: 'memo', label: 'メモ', type: 'textarea', value: project.memo },
      ].filter(Boolean),
   });
   if (values) await actions.updateProject(project.id, values);
}

/** @returns {Promise<boolean>} 削除したら true */
export async function deleteProjectDialog(project) {
   const ok = await confirmDialog({
      title: project.isTemplate ? 'テンプレートを削除' : 'プロジェクトを削除',
      message: project.isTemplate
         ? `「${project.title}」を、セクションとタスクごと削除します。元に戻せません。\nこのテンプレートから作ったプロジェクトには影響しません。`
         : `「${project.title}」を、セクションとタスクごと削除します。元に戻せません。`,
      okLabel: '削除',
      danger: true,
   });
   if (!ok) return false;
   await actions.deleteProject(project.id);
   showToast(`「${project.title}」を削除しました`);
   return true;
}
