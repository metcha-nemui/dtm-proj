// プロジェクトの作成・編集・複製・削除のダイアログ。一覧とボード・アレンジから使う。

import * as actions from '../actions.js';
import { copyAudioFiles, removeAudioFiles } from '../store/audioFileStore.js';
import { confirmDialog, formDialog } from './components/dialog.js';
import { showToast } from './components/toast.js';

/** @returns {Promise<object|null>} 作成したプロジェクト */
export async function newProjectDialog() {
   const values = await formDialog({
      title: '新規プロジェクト',
      submitLabel: '作成',
      fields: [
         // 曲名は作り始めの時点では決まっていないことが多いので、空欄でも作れる(「無題のプロジェクト」になる)
         { name: 'title', label: 'タイトル', placeholder: '曲名(空欄なら「無題のプロジェクト」)' },
         { name: 'dueDate', label: '締切(任意)', type: 'date' },
         { name: 'memo', label: 'メモ(任意)', type: 'textarea' },
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

/** 確認なしで複製する(消すのは簡単で、元のプロジェクトは変わらないため)。 @returns {Promise<object>} 複製したプロジェクト */
export async function duplicateProject(project) {
   const { project: copy, audioFiles } = await actions.duplicateProject(project.id);
   // オーディオトラックの音声は、このブラウザにある分だけ新しい id へ写す(ほかの端末では、選び直してもらう)
   await copyAudioFiles(copy.id, audioFiles).catch(() => {});
   showToast(`「${copy.title}」を作りました`);
   return copy;
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
   // オーディオトラックの音声(このブラウザの IndexedDB にあるもの)も消す。プロジェクトの削除は元に戻せないので、すぐに消してよい
   removeAudioFiles(project.id).catch(() => {});
   showToast(`「${project.title}」を削除しました`);
   return true;
}
