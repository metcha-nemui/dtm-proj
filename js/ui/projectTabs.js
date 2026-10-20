// プロジェクトの中の画面を切り替えるタブ(ボード / アレンジ)。

import { h, icon } from './components/dom.js';
import { enterFullscreenOnPhone } from './fullscreen.js';

const TABS = [
   { key: 'board', label: 'ボード', icon: 'columns-3', href: (id) => `#/p/${encodeURIComponent(id)}` },
   { key: 'arrange', label: 'アレンジ', icon: 'audio-lines', href: (id) => `#/p/${encodeURIComponent(id)}/arrange` },
];

// 最後に開いていた画面を、一覧からプロジェクトを開くときに使う。
// プロジェクトごとには分けず、このブラウザの localStorage に1つだけ覚えておく。
const VIEW_KEY = 'dtm-proj:project-view';

function loadView() {
   try {
      const value = localStorage.getItem(VIEW_KEY);
      return TABS.some((tab) => tab.key === value) ? value : 'board';
   } catch {
      return 'board'; // localStorage を使えない環境では、ボードを開く
   }
}

function saveView(view) {
   try {
      if (view === 'board') localStorage.removeItem(VIEW_KEY);
      else localStorage.setItem(VIEW_KEY, view);
   } catch {
      // 保存できなくても、画面の切り替えには影響しない
   }
}

/** プロジェクトを開くリンク先。最後に開いていた画面(ボードかアレンジ)にする。 */
export function projectHref(projectId) {
   const view = loadView();
   return TABS.find((tab) => tab.key === view).href(projectId);
}

/**
 * @param {string} projectId
 * @param {'board'|'arrange'} active
 */
export function projectTabs(projectId, active) {
   // タブはボードとアレンジの両方が必ず出すので、ここで開いている画面を覚える
   saveView(active);
   return h('nav', { class: 'project-tabs', 'aria-label': '表示の切り替え' }, TABS.map((tab) => h('a', {
      class: `project-tab${tab.key === active ? ' is-active' : ''}`,
      href: tab.href(projectId),
      'aria-current': tab.key === active ? 'page' : null,
      // スマホでは、アレンジを全画面で開く(高さが足りないため。全画面にできるのはタップの中だけ)
      onclick: tab.key === 'arrange' ? () => enterFullscreenOnPhone() : null,
   }, icon(tab.icon, 14), tab.label)));
}
