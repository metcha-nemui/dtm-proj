// プロジェクト一覧の上の、保存先のタブ(オンライン / オフライン)。
// タブはリンクで、押すとそれぞれの保存先のプロジェクト一覧を開く(main.js が保存先を切り替える)。

import { MODES } from '../modes.js';
import { href } from '../route.js';
import { h, icon } from './components/dom.js';

/** @param {'online'|'offline'} active */
export function modeTabs(active) {
   return h('nav', { class: 'project-tabs', 'aria-label': '保存先' }, Object.entries(MODES).map(([mode, m]) => h('a', {
      class: `project-tab${mode === active ? ' is-active' : ''}`,
      href: href('/', mode),
      title: m.title,
      'aria-current': mode === active ? 'page' : null,
   }, icon(m.icon, 14), m.label)));
}

/**
 * 一覧と同じ見出し(「プロジェクト」とタブ)。一覧のほか、オンラインに入れないとき(未ログイン・通信の失敗)の画面にも使い、
 * そこからでもオフラインへ移れるようにする。
 * @param {'online'|'offline'} active
 * @param {...any} actions 右側に並べるボタン
 */
export function listHead(active, ...actions) {
   return h('div', { class: 'page-head' },
      h('div', { class: 'page-head-group' },
         h('h1', { class: 'page-title' }, 'プロジェクト'),
         modeTabs(active)),
      actions.length > 0 && h('div', { class: 'page-head-group' }, actions));
}
