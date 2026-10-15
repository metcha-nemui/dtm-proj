// プロジェクトの締切の表示。一覧のカードとボードの両方で使う。
// 残り日数の文言と色の規則は、一覧の締切パネルでも同じものを使う。

import { daysUntilDue } from '../domain/project.js';
import { isFinished } from '../domain/stats.js';
import { h, icon } from './components/dom.js';

const SOON_DAYS = 3; // これ以内なら「もうすぐ」として色を変える

/** 締切までの日数を「あと◯日 / 今日 / ◯日超過」にする。 */
export function restLabel(days) {
   return days > 0 ? `あと${days}日` : days === 0 ? '今日' : `${-days}日超過`;
}

/** 締切までの日数に応じた状態のクラス(超過 / もうすぐ)。どちらでもなければ空文字。 */
export function dueState(days) {
   return days < 0 ? ' is-overdue' : days <= SOON_DAYS ? ' is-soon' : '';
}

/**
 * @param {object} project
 * @param {{ total: number, done: number }} stats プロジェクト全体の集計
 * @returns {HTMLElement|null} 締切がなければ null
 */
export function dueBadge(project, stats) {
   const days = daysUntilDue(project.dueDate);
   if (days == null) return null;

   // すべて完了していれば、残り日数や超過は出さない
   const finished = isFinished(stats);
   const [year, month, day] = project.dueDate.split('-').map(Number);

   return h('span', { class: `due${finished ? '' : dueState(days)}` },
      icon('calendar', 14),
      `締切 ${year}/${month}/${day}`,
      !finished && `(${restLabel(days)})`);
}
