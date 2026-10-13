// ガントチャート。プロジェクトのボードの下に出す。表示のみで、ここからは編集しない。
// 1日を1列にした CSS Grid で描く。1列目はタスク名で、横にスクロールしても左端に残す。

import { addDays, daysBetween, toDateString } from '../domain/date.js';
import { ganttRange, ganttRows } from '../domain/gantt.js';
import { h, icon } from './components/dom.js';

const HEAD_ROWS = 2; // 月の段と、日の段

// チャートの高さの上限(px)。上端をドラッグして変える。null なら既定(中身に合わせ、画面の半分まで)。
// 再描画しても、開き直しても保つように、このブラウザの localStorage に覚えておく。
const HEIGHT_KEY = 'dtm-proj:gantt-height';
const MIN_HEIGHT = 90; // 見出しと1行が見える高さ
const KEY_STEP = 30; // 矢印キーで動かす量(1行分)

function loadMaxHeight() {
   try {
      const value = Number(localStorage.getItem(HEIGHT_KEY));
      return value >= MIN_HEIGHT ? value : null;
   } catch {
      return null; // localStorage を使えない環境では、その場かぎりにする
   }
}

let maxHeight = loadMaxHeight();

function setMaxHeight(section, value) {
   maxHeight = value;
   if (value) section.style.setProperty('--gantt-max', `${value}px`);
   else section.style.removeProperty('--gantt-max');
}

function saveMaxHeight() {
   try {
      if (maxHeight) localStorage.setItem(HEIGHT_KEY, String(maxHeight));
      else localStorage.removeItem(HEIGHT_KEY);
   } catch {
      // 保存できなくても、開いている間は効く
   }
}

// 上端のつまみ。ドラッグ(または上下の矢印キー)で高さを変え、ダブルクリックで既定に戻す。
// 画面の半分より高くはしない(CSS の max-height でも抑えている)。
function resizeHandle(section) {
   // いま取れる高さの範囲。上は、画面の半分と、中身がすべて見える高さの小さい方
   const clamp = (height) => {
      const scroll = section.querySelector('.gantt-scroll');
      const content = section.offsetHeight - scroll.clientHeight + scroll.scrollHeight;
      const max = Math.min(section.parentElement.clientHeight / 2, content);
      return Math.round(Math.max(MIN_HEIGHT, Math.min(height, max)));
   };

   const handle = h('div', {
      class: 'gantt-resize',
      role: 'separator',
      'aria-orientation': 'horizontal',
      'aria-label': 'ガントチャートの高さ',
      title: 'ドラッグで高さを変える(ダブルクリックで元に戻す)',
      tabIndex: 0,
      dataset: { focusKey: 'gantt-resize' },
      onpointerdown: (down) => {
         if (down.button !== 0) return;
         down.preventDefault(); // ドラッグ中に文字が選択されないようにする
         handle.setPointerCapture(down.pointerId);
         const startHeight = section.offsetHeight;
         const move = (e) => setMaxHeight(section, clamp(startHeight + down.clientY - e.clientY));
         const end = () => {
            handle.removeEventListener('pointermove', move);
            saveMaxHeight();
         };
         handle.addEventListener('pointermove', move);
         handle.addEventListener('pointerup', end, { once: true });
         handle.addEventListener('pointercancel', end, { once: true });
      },
      ondblclick: () => {
         setMaxHeight(section, null);
         saveMaxHeight();
      },
      onkeydown: (e) => {
         if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
         e.preventDefault();
         setMaxHeight(section, clamp(section.offsetHeight + (e.key === 'ArrowUp' ? KEY_STEP : -KEY_STEP)));
         saveMaxHeight();
      },
   });
   return handle;
}

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
      const period = `${monthDay(start)}〜${ongoing ? '(作業中)' : monthDay(end)}`;
      return [
         h('div', { class: 'gantt-label', style: { 'grid-row': row } },
            h('span', { class: 'gantt-title', title: task.title }, task.title),
            !ongoing && icon('check', 14),
            h('span', { class: 'gantt-lane' }, lane?.name ?? '')),
         h('div', { class: 'gantt-line', style: { 'grid-row': row } }),
         h('div', {
            // 色はステータスで塗り分ける(作業中はアクセント色、完了は灰色)。セクションは左の列の名前で示す
            class: `gantt-bar${ongoing ? ' is-ongoing' : ' is-done'}`,
            style: { 'grid-row': row, 'grid-column': `${column(start)} / ${column(end) + 1}` },
            role: 'img',
            'aria-label': `${task.title} ${period}`,
            title: `${task.title} ${period}`,
         }),
      ];
   });

   const section = h('section', {
      class: 'gantt',
      'aria-label': 'ガントチャート',
      style: maxHeight ? { '--gantt-max': `${maxHeight}px` } : null,
   });
   section.append(
      resizeHandle(section),
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
   return section;
}
