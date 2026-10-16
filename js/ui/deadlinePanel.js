// プロジェクト一覧の締切パネル。カードの上に出し、締切の近い順に「リスト」か「タイムライン」で見せる。
// 表示のみで、ここからは編集しない。行を押すと、そのプロジェクトのボードを開く。

import { addDays, daysBetween, toDateString } from '../domain/date.js';
import { deadlineRange, deadlineRows } from '../domain/deadline.js';
import { h, icon } from './components/dom.js';
import { dueState, restLabel } from './dueBadge.js';

const VIEWS = [
   { key: 'list', label: 'リスト', icon: 'list' },
   { key: 'timeline', label: 'タイムライン', icon: 'chart-gantt' },
];

// 選んだ表示は、開き直しても保つように、このブラウザの localStorage に覚えておく
const VIEW_KEY = 'dtm-proj:deadline-view';

function loadView() {
   try {
      const value = localStorage.getItem(VIEW_KEY);
      return VIEWS.some((v) => v.key === value) ? value : 'list';
   } catch {
      return 'list'; // localStorage を使えない環境では、その場かぎりにする
   }
}

let view = loadView();

function saveView() {
   try {
      localStorage.setItem(VIEW_KEY, view);
   } catch {
      // 保存できなくても、開いている間は効く
   }
}

const projectHref = (project) => `#/p/${encodeURIComponent(project.id)}`;

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// 'YYYY-MM-DD' を「M/D」と「(曜)」に分ける。年は出さない(締切の近い順に並ぶので、12月のあとの1月は来年と分かる。
// 今年と再来年が隣り合うことはまずない)。そのぶん日付の欄を狭くして、タイトルに幅を回す
function dateParts(date) {
   const [year, month, day] = date.split('-').map(Number);
   return { monthDay: `${month}/${day}`, weekday: `(${WEEKDAYS[new Date(year, month - 1, day).getDay()]})` };
}

// 「M/D(曜)」
function formatDate(date) {
   const { monthDay, weekday } = dateParts(date);
   return monthDay + weekday;
}

// 日付・曜日・タイトル・残り日数・作業日を別々のセルにする。列の幅は全行で揃える(CSS の subgrid)ので、
// 桁数の違う行が並んでも縦の位置がずれない
function renderList(rows) {
   return h('ol', { class: 'deadline-list' }, rows.map(({ project, days, weekendDays }) => {
      const { monthDay, weekday } = dateParts(project.dueDate);
      return h('li', null,
         h('a', { class: 'deadline-item', href: projectHref(project) },
            h('span', { class: 'deadline-date' }, monthDay),
            h('span', { class: 'deadline-weekday' }, weekday),
            h('span', { class: 'deadline-title' }, project.title),
            h('span', { class: `deadline-rest due${dueState(days)}` }, restLabel(days)),
            // 土日に作業する場合の残り。「あと◯日」のときだけ併記する(今日・超過では意味がない)
            h('span', { class: 'deadline-weekend' }, days > 0 ? `(${weekendDays}作業日)` : '')));
   }));
}

function renderTimeline(rows, today) {
   const { from, days } = deadlineRange(rows, today);
   // 日付の位置(%)。その日の真ん中に置く。パーセントで置くので、画面の幅に合わせて縮み、横スクロールは出ない
   const at = (date) => ((daysBetween(from, date) + 0.5) / days) * 100;

   // 月の区切り。範囲の途中で始まる月の1日に目盛りを立てる。
   // 最初の月は左端に名前だけ出す(次の月の名前と重なるほど近ければ出さない)
   const months = [];
   for (let date = from; daysBetween(date, addDays(from, days - 1)) >= 0; date = addDays(date, 1)) {
      if (date === from || date.endsWith('-01')) months.push(date);
   }
   const monthLabel = (date) => {
      const [year, month] = date.split('-').map(Number);
      return year === Number(today.slice(0, 4)) ? `${month}月` : `${year}年${month}月`;
   };
   const ticks = months.flatMap((date, i) => {
      if (i === 0) {
         const next = months[1];
         return next && at(next) < 15 ? [] : [h('span', { class: 'deadline-tl-month', style: { left: '0%' } }, monthLabel(date))];
      }
      return [h('span', { class: 'deadline-tl-month is-tick', style: { left: `${at(date) - 0.5 / days * 100}%` } }, monthLabel(date))];
   });

   return h('div', { class: 'deadline-tl', style: { '--today': `${at(today)}%` } },
      h('div', { class: 'deadline-tl-head' },
         h('span', { class: 'deadline-tl-legend' }, '今日'),
         h('div', { class: 'deadline-tl-axis' }, ticks)),
      rows.map(({ project, days: rest }) => {
         const left = at(project.dueDate);
         const label = `${project.title} ${formatDate(project.dueDate)}(${restLabel(rest)})`;
         return h('a', { class: 'deadline-tl-row', href: projectHref(project), title: label, 'aria-label': label },
            h('span', { class: 'deadline-title' }, project.title),
            h('span', { class: 'deadline-tl-track' },
               h('span', {
                  // 右端に近い点は、日付を点の左に出す(はみ出さないように)
                  class: `deadline-tl-point${dueState(rest)}${left > 75 ? ' is-flipped' : ''}`,
                  style: { left: `${left}%` },
               }, formatDate(project.dueDate))));
      }));
}

/**
 * @param {{ project: object, stats: { total: number, done: number } }[]} items 一覧の全プロジェクトと、その集計
 * @returns {HTMLElement|null} 締切のある未完了のプロジェクトがなければ null
 */
export function renderDeadlinePanel(items) {
   const today = toDateString(new Date());
   const rows = deadlineRows(items, today);
   if (!rows.length) return null;

   const body = h('div', { class: 'deadline-body' });
   const tabs = VIEWS.map((v) => h('button', {
      type: 'button',
      class: 'project-tab',
      role: 'tab',
      onclick: () => {
         view = v.key;
         saveView();
         render();
      },
   }, icon(v.icon, 14), v.label));

   function render() {
      VIEWS.forEach((v, i) => {
         tabs[i].classList.toggle('is-active', v.key === view);
         tabs[i].setAttribute('aria-selected', String(v.key === view));
      });
      body.replaceChildren(view === 'timeline' ? renderTimeline(rows, today) : renderList(rows));
   }
   render();

   return h('section', { class: 'card deadline-panel', 'aria-label': '締切' },
      h('div', { class: 'deadline-head' },
         h('h2', { class: 'deadline-heading' }, icon('calendar', 16), '締切'),
         h('div', { class: 'project-tabs', role: 'tablist', 'aria-label': '締切の表示' }, tabs)),
      body);
}
