// テンプレート一覧 #/templates
// テンプレートの中身は、プロジェクトと同じボード(#/t/:id)で編集する。

import * as actions from '../actions.js';
import { repo, subscribe } from '../state.js';
import { h, icon } from './components/dom.js';
import { openMenu } from './components/menu.js';
import { reportError } from './components/toast.js';
import { deleteProjectDialog, editProjectDialog, newTemplateDialog } from './projectDialogs.js';

function templateCard(template, { sections, tasks }) {
   const menuButton = h('button', {
      type: 'button',
      class: 'btn btn-icon project-card-menu',
      'aria-label': `「${template.title}」のメニュー`,
      onclick: () => openMenu(menuButton, [
         { label: '名前・メモを編集', onSelect: () => editProjectDialog(template).catch(reportError) },
         { label: '複製', onSelect: () => actions.duplicateTemplate(template.id).catch(reportError) },
         { label: '削除', danger: true, onSelect: () => deleteProjectDialog(template).catch(reportError) },
      ]),
   }, icon('ellipsis-vertical'));

   return h('article', { class: 'card project-card' },
      h('a', { class: 'project-card-link', href: `#/t/${template.id}` },
         h('h2', { class: 'project-card-title' }, template.title),
         template.memo && h('p', { class: 'project-card-memo muted' }, template.memo),
         h('p', { class: 'project-card-meta muted' },
            h('span', null, `セクション${sections}・タスク${tasks}`))),
      menuButton);
}

export function mount(container) {
   const grid = h('div', { class: 'project-grid' });
   const create = () => newTemplateDialog()
      .then((template) => { if (template) location.hash = `#/t/${template.id}`; })
      .catch(reportError);

   container.append(h('div', { class: 'page' },
      h('div', { class: 'page-head' },
         h('h1', { class: 'page-title' }, 'テンプレート'),
         h('button', { type: 'button', class: 'btn btn-primary', onclick: create }, icon('plus'), '新規テンプレート')),
      h('p', { class: 'muted page-lead' },
         '曲の種類ごとに、セクションの並びと毎回やる作業を用意しておきます。プロジェクトを作るときに丸ごとコピーされるので、ここを編集・削除しても作成済みのプロジェクトは変わりません。'),
      grid));

   let alive = true;
   async function refresh() {
      const templates = (await repo().getTemplates()).sort((a, b) => a.title.localeCompare(b.title, 'ja'));
      const counts = await Promise.all(templates.map(async (t) => {
         const [lanes, tasks] = await Promise.all([repo().getLanes(t.id), repo().getTasks(t.id)]);
         return { sections: lanes.filter((l) => l.type === 'section').length, tasks: tasks.length };
      }));
      if (!alive) return;
      const cards = templates.map((template, i) => templateCard(template, counts[i]));
      grid.replaceChildren(...(cards.length ? cards : [
         h('div', { class: 'empty' },
            h('p', null, 'まだテンプレートがありません。'),
            h('p', null, '「新規テンプレート」で作るか、プロジェクトのメニューの「テンプレートとして保存」で作ります。')),
      ]));
   }

   const unsubscribe = subscribe(() => refresh().catch(reportError));
   refresh().catch(reportError);
   return () => {
      alive = false;
      unsubscribe();
   };
}
