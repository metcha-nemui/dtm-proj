// ボードとアレンジのツールバーの先頭(一覧へ戻る、プロジェクト名、リファレンスの一覧、プロジェクトのメニュー)。
// 両方の画面で同じものを同じ並びで出す。違うと、ボード / アレンジのタブの位置が切り替えるたびに動いて押しにくいため。

import { listReferences } from '../domain/reference.js';
import { viewDialog } from './components/dialog.js';
import { h, icon } from './components/dom.js';
import { openMenu } from './components/menu.js';
import { deleteProjectDialog, editProjectDialog } from './projectDialogs.js';

// プロジェクトのタスクに付いているリファレンスの曲名を、名前順に見せる。見るだけで、どのタスクのものかは出さない
function showReferences(tasks) {
   const names = listReferences(tasks);
   return viewDialog({
      title: names.length ? `リファレンス(${names.length}曲)` : 'リファレンス',
      body: names.length
         ? h('ul', { class: 'ref-dialog-list' }, names.map((name) => h('li', null, name)))
         : h('p', { class: 'dialog-message muted' }, 'まだありません。タスク詳細で曲名を付けると、ここに並びます。'),
   });
}

/**
 * @param {object} props
 * @param {object} props.project
 * @param {object[]} props.tasks プロジェクトの全タスク(リファレンスの一覧に使う)
 * @param {(promise: Promise<any>) => void} props.run 失敗をトーストで知らせて実行する
 * @returns {HTMLElement[]} ツールバーに並べる要素
 */
export function projectHead({ project, tasks, run }) {
   const remove = () => run(deleteProjectDialog(project).then((deleted) => { if (deleted) location.hash = '#/'; }));
   const menuButton = h('button', {
      type: 'button',
      class: 'btn btn-icon',
      'aria-label': 'プロジェクトのメニュー',
      dataset: { focusKey: 'project-menu' },
      onclick: () => openMenu(menuButton, [
         { label: '名前・締切・メモを編集', onSelect: () => run(editProjectDialog(project)) },
         { label: 'プロジェクトを削除', danger: true, onSelect: remove },
      ]),
   }, icon('ellipsis-vertical'));

   return [
      h('a', { class: 'btn btn-icon', href: '#/', 'aria-label': 'プロジェクト一覧へ', title: 'プロジェクト一覧へ' }, icon('arrow-left')),
      h('h1', { class: 'board-title', title: project.memo || null }, project.title),
      h('button', {
         type: 'button',
         class: 'btn btn-icon',
         'aria-label': 'リファレンスの一覧',
         title: 'リファレンスの一覧',
         dataset: { focusKey: 'references' },
         onclick: () => run(showReferences(tasks)),
      }, icon('music')),
      menuButton,
   ];
}
