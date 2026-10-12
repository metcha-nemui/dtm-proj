// ライブラリ #/library — セクション種別、定番タスク、構成テンプレートを育てる画面。

import * as actions from '../actions.js';
import { sortByOrder } from '../domain/order.js';
import { colorsInOrder, GLOBAL_LANE_NAME, templatesFor } from '../domain/project.js';
import { repo, subscribe } from '../state.js';
import { confirmDialog, formDialog } from './components/dialog.js';
import { h, icon, keepFocus } from './components/dom.js';
import { openMenu } from './components/menu.js';
import { createSortable, domIndex } from './components/sortable.js';
import { reportError, showToast } from './components/toast.js';

// 画面を行き来しても、選択中のタブと項目は保つ
let tab = 'tasks';
let scope = null; // 定番タスクを表示する系統。null は「全体」、それ以外は kindId
let structureId = null;

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
      root.querySelector('.library-cols').scrollTop = 0;
   };
   const templateCount = (kindId) => templatesFor(library.templateTasks, kindId).length;

   async function refresh() {
      const { kinds, templateTasks, structures } = await repo().getLibrary();
      if (!alive) return;
      library = { kinds: sortByOrder(kinds), templateTasks, structures: sortByOrder(structures) };
      render();
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
      h('span', { class: 'pick-count' }, String(templateCount(id))));
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
         message: `${count ? `この種別の定番タスク${count}件も削除し、` : ''}構成テンプレートからも外します。\n作成済みのプロジェクトのセクションとタスクは残ります。`,
         okLabel: '削除',
         danger: true,
      });
      if (ok) await actions.deleteKind(kind.id);
   }

   function kindsPanel() {
      const list = h('ul', { class: 'pick-list' }, library.kinds.map((kind) => {
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

      return h('section', { class: 'card library-panel' },
         h('h2', { class: 'panel-title' }, 'セクション種別'),
         h('ul', { class: 'pick-list' }, h('li', { class: 'pick-item is-fixed' }, scopeButton(null))),
         list,
         addForm('kind-add', '+ 種別を追加', (name) => actions.addKind({ name }).then((kind) => { scope = kind.id; })));
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

   function templatesPanel() {
      const kind = library.kinds.find((k) => k.id === scope) ?? null;
      const list = h('ul', { class: 'template-list' }, templatesFor(library.templateTasks, scope).map(templateItem));
      sortables.push(createSortable(list, {
         draggable: '.template-item',
         handle: '.drag-handle',
         onEnd: ({ item, oldIndex, newIndex }) => {
            if (oldIndex !== newIndex) run(actions.moveTemplateTask(item.dataset.id, domIndex(item, '.template-item')));
         },
      }));

      return h('section', { class: 'card library-panel' },
         h('h2', { class: 'panel-title' }, `「${kind?.name ?? GLOBAL_LANE_NAME}」の定番タスク`),
         h('p', { class: 'muted panel-hint' }, kind
            ? 'この種別のセクションを作るたびにコピーされます。並び順が、そのまま初期の作業順になります。'
            : 'プロジェクトを作るたびに、「全体」レーンへコピーされます。並び順が、そのまま初期の作業順になります。'),
         list,
         addForm('template-add', '+ 定番タスクを追加', (title) => actions.addTemplateTask({ kindId: scope, title })));
   }

   // ---- 構成テンプレート ----

   function structuresPanel() {
      return h('section', { class: 'card library-panel' },
         h('h2', { class: 'panel-title' }, '構成テンプレート'),
         h('ul', { class: 'pick-list' }, library.structures.map((s) => h('li', { class: 'pick-item is-fixed' },
            h('button', {
               type: 'button',
               class: 'pick',
               'aria-pressed': String(structureId === s.id),
               dataset: { focusKey: `structure:${s.id}` },
               onclick: () => select(() => { structureId = s.id; }),
            },
            h('span', { class: 'pick-name' }, s.name),
            h('span', { class: 'pick-count' }, String(s.sections.length)))))),
         addForm('structure-add', '+ テンプレートを追加',
            (name) => actions.addStructure({ name }).then((s) => { structureId = s.id; })));
   }

   function structureEditor() {
      const structure = library.structures.find((s) => s.id === structureId);
      if (!structure) {
         return h('section', { class: 'card library-panel' },
            h('p', { class: 'empty' }, '構成テンプレートがありません。左の欄から追加します。'));
      }
      const kinds = new Map(library.kinds.map((k) => [k.id, k]));
      const save = (patch) => run(actions.updateStructure(structure.id, patch));
      const { sections } = structure;
      // このテンプレートで作ったプロジェクトと同じ色になる(並び順に割り振る)
      const colors = colorsInOrder(sections);

      const chips = h('ol', { class: 'chip-list' }, sections.map((kindId, i) => {
         const name = kinds.get(kindId)?.name ?? '(削除済みの種別)';
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
      const remove = async () => {
         const ok = await confirmDialog({
            title: `「${structure.name}」を削除`,
            message: 'この構成テンプレートを削除します。作成済みのプロジェクトには影響しません。',
            okLabel: '削除',
            danger: true,
         });
         if (ok) await actions.deleteStructure(structure.id);
      };

      return h('section', { class: 'card library-panel' },
         h('div', { class: 'field' },
            h('label', { class: 'field-label', for: 'structure-name' }, '名前'),
            h('input', {
               class: 'input',
               id: 'structure-name',
               value: structure.name,
               autocomplete: 'off',
               dataset: { focusKey: 'structure-name' },
               onchange: (e) => {
                  if (e.target.value.trim()) save({ name: e.target.value });
                  else e.target.value = structure.name;
               },
            })),
         h('div', { class: 'field' },
            h('span', { class: 'field-label' }, `セクションの並び(${sections.length})`),
            chips,
            h('p', { class: 'muted panel-hint' }, 'ドラッグで並べ替えます。同じ種別を何度入れてもかまいません(「サビ」「サビ2」のように番号が付きます)。'),
            h('div', { class: 'kind-buttons' }, library.kinds.map((kind) => h('button', {
               type: 'button',
               class: 'btn kind-button',
               dataset: { focusKey: `structure-add-kind:${kind.id}` },
               onclick: () => save({ sections: [...sections, kind.id] }),
            }, icon('plus', 14), kind.name)))),
         h('div', { class: 'panel-foot' },
            h('span', { class: 'muted' }, `このテンプレートで作ると、「全体」を含めて定番タスク${taskCount}件から始まります。`),
            h('button', { type: 'button', class: 'btn btn-danger', onclick: () => run(remove()) }, 'テンプレートを削除')));
   }

   // ---- 全体 ----

   function render() {
      if (scope && !library.kinds.some((k) => k.id === scope)) scope = null;
      if (!library.structures.some((s) => s.id === structureId)) structureId = library.structures[0]?.id ?? null;
      for (const sortable of sortables) sortable?.destroy();
      sortables = [];

      const tabButton = (id, label) => h('button', {
         type: 'button',
         role: 'tab',
         class: 'tab',
         'aria-selected': String(tab === id),
         dataset: { focusKey: `tab:${id}` },
         onclick: () => select(() => { tab = id; }),
      }, label);

      // スクロールするのは .library-cols。再描画で位置が飛ばないように引き継ぐ
      const scrollTop = root.querySelector('.library-cols')?.scrollTop ?? 0;
      keepFocus(root, () => root.replaceChildren(
         h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, 'ライブラリ')),
         h('p', { class: 'muted library-lead' },
            '毎回やる定番作業をここで育てます。プロジェクトやセクションを作るときにコピーされるので、ここを編集しても作成済みのプロジェクトは変わりません。'),
         h('div', { class: 'tabs', role: 'tablist' },
            tabButton('tasks', '種別と定番タスク'),
            tabButton('structures', '構成テンプレート')),
         h('div', { class: 'library-cols' },
            tab === 'tasks' ? [kindsPanel(), templatesPanel()] : [structuresPanel(), structureEditor()])));
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
