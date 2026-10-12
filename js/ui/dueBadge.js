// プロジェクトの締切の表示。一覧のカードとボードの両方で使う。

import { daysUntilDue } from '../domain/project.js';
import { h, icon } from './components/dom.js';

const SOON_DAYS = 3; // これ以内なら「もうすぐ」として色を変える

/**
 * @param {object} project
 * @param {{ total: number, done: number }} stats プロジェクト全体の集計
 * @returns {HTMLElement|null} 締切がなければ null
 */
export function dueBadge(project, stats) {
   const days = daysUntilDue(project.dueDate);
   if (days == null) return null;

   // すべて完了していれば、残り日数や超過は出さない
   const finished = stats.total > 0 && stats.done === stats.total;
   const rest = days > 0 ? `あと${days}日` : days === 0 ? '今日' : `${-days}日超過`;
   const state = finished ? '' : days < 0 ? ' is-overdue' : days <= SOON_DAYS ? ' is-soon' : '';
   const [year, month, day] = project.dueDate.split('-').map(Number);

   return h('span', { class: `due${state}` },
      icon('calendar', 14),
      `締切 ${year}/${month}/${day}`,
      !finished && `(${rest})`);
}
