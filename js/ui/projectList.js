// プロジェクト一覧 #/

import { summarize } from '../domain/stats.js';
import { repo, subscribe } from '../state.js';
import { h, icon, progressBar } from './components/dom.js';
import { openMenu } from './components/menu.js';
import { reportError } from './components/toast.js';
import { renderDeadlinePanel } from './deadlinePanel.js';
import { dueBadge } from './dueBadge.js';
import { deleteProjectDialog, editProjectDialog, newProjectDialog } from './projectDialogs.js';

const dateFormat = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'short', timeStyle: 'short' });

function projectCard(project, stats) {
   const menuButton = h('button', {
      type: 'button',
      class: 'btn btn-icon project-card-menu',
      'aria-label': `「${project.title}」のメニュー`,
      onclick: () => openMenu(menuButton, [
         { label: '名前・締切・メモを編集', onSelect: () => editProjectDialog(project).catch(reportError) },
         { label: '削除', danger: true, onSelect: () => deleteProjectDialog(project).catch(reportError) },
      ]),
   }, icon('ellipsis-vertical'));

   return h('article', { class: 'card project-card' },
      h('a', { class: 'project-card-link', href: `#/p/${project.id}` },
         h('h2', { class: 'project-card-title' }, project.title),
         project.memo && h('p', { class: 'project-card-memo muted' }, project.memo),
         dueBadge(project, stats),
         progressBar(stats.ratio),
         h('p', { class: 'project-card-meta muted' },
            h('span', null, `${stats.done}/${stats.total} 完了`),
            h('span', null, `最終更新 ${dateFormat.format(new Date(project.updatedAt))}`))),
      menuButton);
}

export function mount(container) {
   const grid = h('div', { class: 'project-grid' });
   // 締切パネルの差し込み口。締切のある未完了のプロジェクトがなければ空のまま
   const deadlines = h('div', { class: 'deadline-slot' });
   const create = () => newProjectDialog()
      .then((project) => { if (project) location.hash = `#/p/${project.id}`; })
      .catch(reportError);

   container.append(h('div', { class: 'page' },
      h('div', { class: 'page-head' },
         h('h1', { class: 'page-title' }, 'プロジェクト'),
         // 設定へはここからだけ行く(編集しながら何度も開くものではないので、ほかの画面には置かない)
         h('div', { class: 'page-head-group' },
            h('a', { class: 'btn btn-icon', href: '#/settings', 'aria-label': '設定', title: '設定' }, icon('settings')),
            h('button', { type: 'button', class: 'btn btn-primary', onclick: create }, icon('plus'), '新規プロジェクト'))),
      deadlines,
      grid));

   let alive = true;
   async function refresh() {
      const projects = await repo().getProjects();
      const stats = await Promise.all(projects.map(async (p) => summarize(await repo().getTasks(p.id))));
      if (!alive) return;
      const items = projects.map((project, i) => ({ project, stats: stats[i] }));
      deadlines.replaceChildren(...[renderDeadlinePanel(items)].filter(Boolean));
      const cards = [...items]
         .sort((a, b) => (a.project.updatedAt < b.project.updatedAt ? 1 : -1))
         .map(({ project, stats: s }) => projectCard(project, s));
      grid.replaceChildren(...(cards.length ? cards : [
         h('div', { class: 'empty' },
            h('p', null, 'まだプロジェクトがありません。'),
            h('p', null, '「新規プロジェクト」から、曲のタイトルを入れて始めます。')),
      ]));
   }

   const unsubscribe = subscribe(() => refresh().catch(reportError));
   refresh().catch(reportError);
   return () => {
      alive = false;
      unsubscribe();
   };
}
