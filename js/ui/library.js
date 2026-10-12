// ライブラリ #/library — テンプレート(セクションの並び、セクション種別、定番タスク)を育てる画面。

import * as actions from '../actions.js';
import { sortByOrder } from '../domain/order.js';
import { colorsInOrder, GLOBAL_LANE_NAME, templatesFor } from '../domain/project.js';
import { repo, subscribe } from '../state.js';
import { confirmDialog, formDialog } from './components/dialog.js';
import { h, icon, keepFocus } from './components/dom.js';
import { openMenu } from './components/menu.js';
import { createSortable, domIndex } from './components/sortable.js';
import { reportError, showToast } from './components/toast.js';

// 画面を行き来しても、選択中の項目は保つ
let templateId = null;
let scope = null; // 定番タスクを表示する系統。null は「全体」、それ以外は kindId

export function mount(container) {
   const root = h('div', { class: 'page library-page' });
   container.append(root);

   let alive = true;
   let library = null;
   let sortables = [];
   const run = (promise) => promise.catch(reportError);
   const select = (change) => {
      change();
      render();
   };
   const selectTemplate = (id) => {
      templateId = id;
      scope = null;
   };
   // 選択中のテンプレートの種別と、その定番タスクの件数
   const kindsOf = (id) => library.kinds.filter((k) => k.templateId === id);
   const templateCount = (kindId) => templatesFor(library.templateTasks, templateId, kindId).length;

   async function refresh() {
      const { templates, kinds, templateTasks } = await repo().getLibrary();
      if (!alive) return;
      library = { templates: sortByOrder(templates), kinds: sortByOrder(kinds), templateTasks };
      render();
   }

   // 名前を1つ入力して追加するフォーム。Enterで追加し、連続入力できる。
   function addForm(focusKey, placeholder, onAdd) {
      const input = h('input', {
         class: 'input', placeholder, 'aria-label': placeholder, autocomplete: 'off', dataset: { focusKey },
      });
      return h('form', {
         class: 'add-form',
         onsubmit: (e) => {
            e.preventDefault();
            const value = input.value.trim();
            if (!value) return;
            input.value = '';
            run(onAdd(value));
         },
      }, input);
   }

   // ---- テンプレートの一覧 ----

   async function deleteTemplateDialog(template) {
      const ok = await confirmDialog({
         title: `「${template.name}」を削除`,
         message: 'このテンプレートを、セクション種別と定番タスクごと削除します。\n'
            + '作成済みのプロジェクトは残りますが、そのプロジェクトでは種別を選べなくなり、定番への追加もできなくなります。',
         okLabel: '削除',
         danger: true,
      });
      if (ok) await actions.deleteTemplate(template.id);
   }

   function templatesPanel() {
      return h('section', { class: 'card library-panel' },
         h('h2', { class: 'panel-title' }, 'テンプレート'),
         h('ul', { class: 'pick-list' }, library.templates.map((template) => {
            const menuButton = h('button', {
               type: 'button',
               class: 'btn btn-icon',
               'aria-label': `${template.name}のメニュー`,
               dataset: { focusKey: `template-menu:${template.id}` },
               onclick: () => openMenu(menuButton, [
                  {
                     label: '複製',
                     onSelect: () => run(actions.duplicateTemplate(template.id).then((copy) => selectTemplate(copy.id))),
                  },
                  { label: '削除', danger: true, onSelect: () => run(deleteTemplateDialog(template)) },
               ]),
            }, icon('ellipsis-vertical'));
            return h('li', { class: 'pick-item is-fixed' },
               h('button', {
                  type: 'button',
                  class: 'pick',
                  'aria-pressed': String(templateId === template.id),
                  dataset: { focusKey: `template:${template.id}` },
                  onclick: () => {
                     select(() => selectTemplate(template.id));
                     root.querySelector('.library-cols').scrollTop = 0;
                  },
               },
               h('span', { class: 'pick-name' }, template.name),
               h('span', { class: 'pick-count', title: 'セクションの数' }, String(template.sections.length))),
               menuButton);
         })),
         addForm('template-add', '+ テンプレートを追加',
            (name) => actions.addTemplate({ name }).then((template) => selectTemplate(template.id))));
   }

   // ---- 名前とセクションの並び ----

   function sectionsPanel(template) {
      const kinds = kindsOf(template.id);
      const names = new Map(kinds.map((k) => [k.id, k.name]));
      const save = (patch) => run(actions.updateTemplate(template.id, patch));
      const { sections } = template;
      // このテンプレートで作ったプロジェクトと同じ色になる(並び順に割り振る)
      const colors = colorsInOrder(sections);

      const chips = h('ol', { class: 'chip-list' }, sections.map((kindId, i) => {
         const name = names.get(kindId) ?? '(削除済みの種別)';
         return h('li', { class: 'chip', dataset: { kindId }, style: { '--lane-color': colors[i] } },
            h('span', null, name),
            h('button', {
               type: 'button',
               class: 'chip-remove',
               'aria-label': `${i + 1}番目の${name}を外す`,
               onclick: () => save({ sections: sections.filter((_, n) => n !== i) }),
            }, icon('x', 12)));
      }));
      sortables.push(createSortable(chips, {
         draggable: '.chip',
         filter: 'button',
         preventOnFilter: false,
         onEnd: ({ oldIndex, newIndex }) => {
            if (oldIndex === newIndex) return;
            save({ sections: [...chips.querySelectorAll(':scope > .chip')].map((chip) => chip.dataset.kindId) });
         },
      }));

      const taskCount = sections.reduce((n, kindId) => n + templateCount(kindId), 0) + templateCount(null);

      return h('section', { class: 'card library-panel' },
         h('div', { class: 'field' },
            h('label', { class: 'field-label', for: 'template-name' }, '名前'),
            h('input', {
               class: 'input',
               id: 'template-name',
               value: template.name,
               autocomplete: 'off',
               dataset: { focusKey: 'template-name' },
               onchange: (e) => {
                  if (e.target.value.trim()) save({ name: e.target.value });
                  else e.target.value = template.name;
               },
            })),
         h('div', { class: 'field' },
            h('span', { class: 'field-label' }, `セクションの並び(${sections.length})`),
            chips,
            h('p', { class: 'muted panel-hint' }, kinds.length
               ? 'ドラッグで並べ替えます。同じ種別を何度入れてもかまいません(「サビ」「サビ2」のように番号が付きます)。'
               : '下の「セクション種別」に種別を追加すると、ここに並べられます。'),
            h('div', { class: 'kind-buttons' }, kinds.map((kind) => h('button', {
               type: 'button',
               class: 'btn kind-button',
               dataset: { focusKey: `section-add-kind:${kind.id}` },
               onclick: () => save({ sections: [...sections, kind.id] }),
            }, icon('plus', 14), kind.name)))),
         h('p', { class: 'muted panel-foot' }, `このテンプレートで作ると、「全体」を含めて定番タスク${taskCount}件から始まります。`));
   }

   // ---- セクション種別と定番タスク ----

   function scopeButton(kind) {
      const id = kind?.id ?? null;
      return h('button', {
         type: 'button',
         class: 'pick',
         'aria-pressed': String(scope === id),
         dataset: { focusKey: `scope:${id}` },
         onclick: () => select(() => { scope = id; }),
      },
      h('span', { class: 'pick-name' }, kind?.name ?? GLOBAL_LANE_NAME),
      h('span', { class: 'pick-count', title: '定番タスクの数' }, String(templateCount(id))));
   }

   async function renameKindDialog(kind) {
      const values = await formDialog({
         title: '名前を変更',
         fields: [{ name: 'name', label: '名前', value: kind.name, required: true }],
      });
      if (values) await actions.updateKind(kind.id, values);
   }

   async function deleteKindDialog(kind) {
      const count = templateCount(kind.id);
      const ok = await confirmDialog({
         title: `「${kind.name}」を削除`,
         message: `${count ? `この種別の定番タスク${count}件も削除し、` : ''}セクションの並びからも外します。\n作成済みのプロジェクトのセクションとタスクは残ります。`,
         okLabel: '削除',
         danger: true,
      });
      if (ok) await actions.deleteKind(kind.id);
   }

   function kindsList(template) {
      const list = h('ul', { class: 'pick-list' }, kindsOf(template.id).map((kind) => {
         const menuButton = h('button', {
            type: 'button',
            class: 'btn btn-icon',
            'aria-label': `${kind.name}のメニュー`,
            dataset: { focusKey: `kind-menu:${kind.id}` },
            onclick: () => openMenu(menuButton, [
               { label: '名前を変更', onSelect: () => run(renameKindDialog(kind)) },
               { label: '削除', danger: true, onSelect: () => run(deleteKindDialog(kind)) },
            ]),
         }, icon('ellipsis-vertical'));
         return h('li', { class: 'pick-item', dataset: { id: kind.id } },
            h('span', { class: 'drag-handle', title: 'ドラッグで並べ替え', 'aria-hidden': 'true' }, icon('grip-vertical')),
            scopeButton(kind),
            menuButton);
      }));
      sortables.push(createSortable(list, {
         draggable: '.pick-item',
         handle: '.drag-handle',
         onEnd: ({ item, oldIndex, newIndex }) => {
            if (oldIndex !== newIndex) run(actions.moveKind(item.dataset.id, domIndex(item, '.pick-item')));
         },
      }));

      return h('div', { class: 'kinds-col' },
         h('h2', { class: 'panel-title' }, 'セクション種別'),
         h('ul', { class: 'pick-list' }, h('li', { class: 'pick-item is-fixed' }, scopeButton(null))),
         list,
         addForm('kind-add', '+ 種別を追加',
            (name) => actions.addKind({ templateId: template.id, name }).then((kind) => { scope = kind.id; })));
   }

   function templateItem(templateTask) {
      const { id } = templateTask;
      const save = (patch) => run(actions.updateTemplateTask(id, patch));
      const remove = () => run(actions.deleteTemplateTask(id).then((deleted) => {
         showToast(`「${deleted.title}」を定番から削除しました`, {
            actionLabel: '元に戻す',
            onAction: () => run(actions.restoreTemplateTask(deleted)),
         });
      }));

      return h('li', { class: 'template-item', dataset: { id } },
         h('span', { class: 'drag-handle', title: 'ドラッグで並べ替え', 'aria-hidden': 'true' }, icon('grip-vertical')),
         h('input', {
            class: 'input template-title',
            value: templateTask.title,
            'aria-label': 'タイトル',
            autocomplete: 'off',
            dataset: { focusKey: `template-title:${id}` },
            onchange: (e) => {
               if (e.target.value.trim()) save({ title: e.target.value });
               else e.target.value = templateTask.title;
            },
         }),
         h('button', {
            type: 'button',
            class: 'btn btn-icon',
            title: '定番から削除',
            'aria-label': `${templateTask.title}を定番から削除`,
            onclick: remove,
         }, icon('trash-2')),
         h('textarea', {
            class: 'textarea template-memo',
            rows: 1,
            value: templateTask.memo,
            placeholder: 'メモ(任意)',
            'aria-label': 'メモ',
            dataset: { focusKey: `template-memo:${id}` },
            onchange: (e) => save({ memo: e.target.value }),
         }));
   }

   function tasksList(template) {
      const kind = library.kinds.find((k) => k.id === scope) ?? null;
      const list = h('ul', { class: 'template-list' }, templatesFor(library.templateTasks, template.id, scope).map(templateItem));
      sortables.push(createSortable(list, {
         draggable: '.template-item',
         handle: '.drag-handle',
         onEnd: ({ item, oldIndex, newIndex }) => {
            if (oldIndex !== newIndex) run(actions.moveTemplateTask(item.dataset.id, domIndex(item, '.template-item')));
         },
      }));

      return h('div', { class: 'tasks-col' },
         h('h2', { class: 'panel-title' }, `「${kind?.name ?? GLOBAL_LANE_NAME}」の定番タスク`),
         h('p', { class: 'muted panel-hint' }, kind
            ? 'この種別のセクションを作るたびにコピーされます。並び順が、そのまま初期の作業順になります。'
            : 'このテンプレートでプロジェクトを作るたびに、「全体」レーンへコピーされます。並び順が、そのまま初期の作業順になります。'),
         list,
         addForm('template-task-add', '+ 定番タスクを追加',
            (title) => actions.addTemplateTask({ templateId: template.id, kindId: scope, title })));
   }

   // ---- 全体 ----

   function detail() {
      const template = library.templates.find((t) => t.id === templateId);
      if (!template) {
         return h('section', { class: 'card library-panel' },
            h('p', { class: 'empty' }, 'テンプレートがありません。左の欄から追加します。'));
      }
      return h('div', { class: 'library-detail' },
         sectionsPanel(template),
         h('section', { class: 'card library-panel kinds-panel' }, kindsList(template), tasksList(template)));
   }

   function render() {
      if (!library.templates.some((t) => t.id === templateId)) selectTemplate(library.templates[0]?.id ?? null);
      if (scope && !kindsOf(templateId).some((k) => k.id === scope)) scope = null;
      for (const sortable of sortables) sortable?.destroy();
      sortables = [];

      // スクロールするのは .library-cols。再描画で位置が飛ばないように引き継ぐ
      const scrollTop = root.querySelector('.library-cols')?.scrollTop ?? 0;
      keepFocus(root, () => root.replaceChildren(
         h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, 'ライブラリ')),
         h('p', { class: 'muted library-lead' },
            '曲の種類ごとのテンプレートに、セクションの並びと毎回やる定番作業を育てます。プロジェクトやセクションを作るときにコピーされるので、ここを編集しても作成済みのプロジェクトは変わりません。'),
         h('div', { class: 'library-cols' }, templatesPanel(), detail())));
      root.querySelector('.library-cols').scrollTop = scrollTop;
   }

   const unsubscribe = subscribe(() => run(refresh()));
   run(refresh());
   return () => {
      alive = false;
      unsubscribe();
      for (const sortable of sortables) sortable?.destroy();
   };
}
