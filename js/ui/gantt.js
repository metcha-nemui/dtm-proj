// ガントチャート。プロジェクトのボードの下に出す。表示のみで、ここからは編集しない。
// 1日を1列にした CSS Grid で描く。1列目はタスク名で、横にスクロールしても左端に残す。

import { addDays, daysBetween, toDateString } from '../domain/date.js';
import { ganttRange, ganttRows } from '../domain/gantt.js';
import { sectionColors } from '../domain/project.js';
import { h, icon } from './components/dom.js';

const HEAD_ROWS = 2; // 月の段と、日の段

const monthDay = (date) => {
   const [, month, day] = date.split('-').map(Number);
   return `${month}/${day}`;
};

/**
 * @param {{ project: object, lanes: object[], tasks: object[] }} data
 * @returns {HTMLElement|null} 出すタスクがなければ null
 */
export function renderGantt({ project, lanes, tasks }) {
   const today = toDateString(new Date());
   const rows = ganttRows(tasks, lanes, today);
   if (!rows.length) return null;

   const { from, days } = ganttRange(rows, today, project.dueDate);
   const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
   const colors = sectionColors(lanes);
   const column = (date) => daysBetween(from, date) + 2; // 1列目はタスク名
   const isWeekend = (date) => [0, 6].includes(new Date(`${date}T00:00`).getDay());
   const mark = (date) => (date === today ? ' is-today' : date === project.dueDate ? ' is-due' : isWeekend(date) ? ' is-weekend' : '');

   // 月の段。月ごとに、その月の日数ぶんの列をまたぐ
   const months = [];
   dates.forEach((date, i) => {
      const key = date.slice(0, 7);
      if (months.at(-1)?.key === key) months.at(-1).span++;
      else months.push({ key, start: i + 2, span: 1 });
   });
   const monthCells = months.map(({ key, start, span }) => {
      const [year, month] = key.split('-').map(Number);
      return h('div', { class: 'gantt-month', style: { 'grid-column': `${start} / span ${span}` } },
         h('span', null, `${year}年${month}月`));
   });

   const dayCells = dates.map((date, i) => h('div', {
      class: `gantt-day${mark(date)}`,
      style: { 'grid-column': String(i + 2) },
      title: date === today ? '今日' : date === project.dueDate ? '締切' : null,
   }, String(Number(date.slice(8)))));

   // 土日・今日・締切の列に、行の下まで色を敷く
   const stripes = dates.filter((date) => mark(date)).map((date) => h('div', {
      class: `gantt-stripe${mark(date)}`,
      style: { 'grid-column': String(column(date)), 'grid-row': `${HEAD_ROWS + 1} / -1` },
   }));

   const body = rows.flatMap(({ task, lane, start, end, ongoing }, i) => {
      const row = String(i + HEAD_ROWS + 1);
      // 「全体」レーンには色を割り振っていないので、アクセント色にする
      const color = { '--lane-color': colors.get(lane?.id) ?? 'var(--accent)' };
      const period = `${monthDay(start)}〜${ongoing ? '(作業中)' : monthDay(end)}`;
      return [
         h('div', { class: 'gantt-label', style: { 'grid-row': row, ...color } },
            h('span', { class: 'gantt-dot' }),
            h('span', { class: 'gantt-title', title: task.title }, task.title),
            !ongoing && icon('check', 14),
            h('span', { class: 'gantt-lane' }, lane?.name ?? '')),
         h('div', { class: 'gantt-line', style: { 'grid-row': row } }),
         h('div', {
            class: `gantt-bar${ongoing ? ' is-ongoing' : ''}`,
            style: { 'grid-row': row, 'grid-column': `${column(start)} / ${column(end) + 1}`, ...color },
            role: 'img',
            'aria-label': `${task.title} ${period}`,
            title: `${task.title} ${period}`,
         }),
      ];
   });

   return h('section', { class: 'gantt', 'aria-label': 'ガントチャート' },
      h('div', { class: 'gantt-scroll' },
         h('div', {
            class: 'gantt-grid',
            style: {
               'grid-template-columns': `var(--gantt-label) repeat(${days}, var(--gantt-day))`,
               'grid-template-rows': `repeat(${HEAD_ROWS}, var(--gantt-head)) repeat(${rows.length}, var(--gantt-row))`,
            },
         },
         stripes,
         h('div', { class: 'gantt-corner' },
            h('span', { class: 'gantt-legend is-today' }, '今日'),
            project.dueDate && h('span', { class: 'gantt-legend is-due' }, '締切')),
         monthCells,
         dayCells,
         body)));
}
