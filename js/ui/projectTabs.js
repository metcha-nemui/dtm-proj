// プロジェクトの中の画面を切り替えるタブ(ボード / アレンジ)。テンプレートには出さない。

import { h, icon } from './components/dom.js';

const TABS = [
   { key: 'board', label: 'ボード', icon: 'columns-3', href: (id) => `#/p/${encodeURIComponent(id)}` },
   { key: 'arrange', label: 'アレンジ', icon: 'audio-lines', href: (id) => `#/p/${encodeURIComponent(id)}/arrange` },
];

/**
 * @param {string} projectId
 * @param {'board'|'arrange'} active
 */
export function projectTabs(projectId, active) {
   return h('nav', { class: 'project-tabs', 'aria-label': '表示の切り替え' }, TABS.map((tab) => h('a', {
      class: `project-tab${tab.key === active ? ' is-active' : ''}`,
      href: tab.href(projectId),
      'aria-current': tab.key === active ? 'page' : null,
   }, icon(tab.icon, 14), tab.label)));
}
