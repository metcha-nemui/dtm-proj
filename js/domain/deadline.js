// プロジェクト一覧の締切パネルに出す内容の計算。DOMにもrepositoryにも依存しない。

import { addDays, daysBetween, weekendDaysBetween } from './date.js';
import { isFinished } from './stats.js';

const RANGE_MARGIN = 3; // タイムラインの前後に足す日数

/**
 * 締切パネルの行。締切があり、まだ終わっていないプロジェクトだけを、締切の早い順に並べる(同じ日ならタイトル順)。
 * 全タスクが完了したプロジェクトは、締切を気にする必要がないので出さない。
 * @param {{ project: object, stats: { total: number, done: number } }[]} items
 * @param {string} today 今日(YYYY-MM-DD)
 * @returns {{ project: object, days: number, weekendDays: number }[]}
 *    days は締切までの日数(今日が締切なら 0、過ぎていれば負の数)。
 *    weekendDays は、そのうちの土日の日数(土日に作業する人の目安。今日と過ぎた締切は 0)
 */
export function deadlineRows(items, today) {
   return items
      .filter(({ project, stats }) => project.dueDate && !isFinished(stats))
      .sort((a, b) => (a.project.dueDate === b.project.dueDate
         ? a.project.title.localeCompare(b.project.title, 'ja')
         : a.project.dueDate < b.project.dueDate ? -1 : 1))
      .map(({ project }) => ({
         project,
         days: daysBetween(today, project.dueDate),
         weekendDays: weekendDaysBetween(today, project.dueDate),
      }));
}

/**
 * タイムラインに出す期間。今日と全締切のうち最も早い日の数日前から、最も遅い日の数日後まで。
 * @param {{ project: { dueDate: string } }[]} rows
 * @param {string} today 今日(YYYY-MM-DD)
 * @returns {{ from: string, days: number }} 最初の日と、日数
 */
export function deadlineRange(rows, today) {
   const dates = [today, ...rows.map((r) => r.project.dueDate)].sort();
   const from = addDays(dates[0], -RANGE_MARGIN);
   return { from, days: daysBetween(from, dates.at(-1)) + RANGE_MARGIN + 1 };
}
