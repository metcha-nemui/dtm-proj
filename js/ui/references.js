// リファレンス一覧(#/p/:id/refs)。プロジェクトのタスクに付いているリファレンスの曲名を並べる。
// 見るためだけの画面で、ここでは編集しない(付ける・外すはタスク詳細で行う)。どのタスクに付いているかも出さない。
// プロジェクトだけの画面で、テンプレートにはない(テンプレートはリファレンスを持たない)。

import { listReferences } from '../domain/reference.js';
import { repo, subscribe } from '../state.js';
import { h, icon } from './components/dom.js';
import { reportError } from './components/toast.js';
import { projectTabs } from './projectTabs.js';

export function mount(container, { id: projectId }) {
   const root = h('div', { class: 'refs-page' });
   container.append(root);
   let alive = true;
   const run = (promise) => promise.catch(reportError);

   function render(project, names) {
      if (!project || project.isTemplate) {
         root.replaceChildren(h('div', { class: 'empty' },
            h('p', null, project ? 'テンプレートにはリファレンスはありません。' : 'プロジェクトが見つかりません。'),
            h('p', null, h('a', { href: '#/' }, 'プロジェクト一覧へ'))));
         return;
      }
      root.replaceChildren(
         h('div', { class: 'board-toolbar' },
            h('a', { class: 'btn btn-icon', href: '#/', 'aria-label': 'プロジェクト一覧へ', title: 'プロジェクト一覧へ' }, icon('arrow-left')),
            h('h1', { class: 'board-title', title: project.memo || null }, project.title),
            projectTabs(projectId, 'refs'),
            h('span', { class: 'muted board-summary' }, `${names.length}曲`)),
         names.length
            ? h('ul', { class: 'refs-list' }, names.map((name) => h('li', { class: 'refs-item' }, name)))
            : h('div', { class: 'empty' },
               h('p', null, 'まだリファレンスはありません。'),
               h('p', null, 'ボードのタスク詳細で曲名を付けると、ここに並びます。')));
   }

   async function refresh() {
      const [project, tasks] = await Promise.all([repo().getProject(projectId), repo().getTasks(projectId)]);
      if (!alive) return;
      render(project, listReferences(tasks));
   }

   const unsubscribe = subscribe(() => run(refresh()));
   run(refresh());
   return () => {
      alive = false;
      unsubscribe();
   };
}
