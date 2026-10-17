// ガントチャートに出す内容の計算。DOMにもrepositoryにも依存しない。
// 日付は実績(着手した日・終わった日)なので、チャートは「これまでの作業の記録」になる。

import { addDays, daysBetween, toDateString } from './date.js';
import { isUnassigned } from './task.js';

const RANGE_MARGIN = 3; // 表示範囲の前後に足す日数

/**
 * チャートの行。着手済み(作業中・完了)で、開始日のあるタスクだけを出す。
 * 並びは、作業中のものが先(いま手を付けているものを上で見られるように)。その中で、セクションをまたいで開始日の早い順。
 * 同じなら終わりの早い順、その次はボードでの並び順。
 * @param {object[]} tasks プロジェクトの全タスク
 * @param {object[]} lanes プロジェクトの全レーン
 * @param {string} today 今日(YYYY-MM-DD)
 * @returns {{ task: object, lane: object|null, start: string, end: string, ongoing: boolean }[]}
 *    ongoing は、まだ終わっておらず、バーを今日まで伸ばしているもの
 */
export function ganttRows(tasks, lanes, today) {
   const laneById = new Map(lanes.map((l) => [l.id, l]));
   // ボードでの並び順。「全体」レーンが先で、あとはセクションの並び順
   const laneRank = (lane) => (lane ? [lane.type === 'global' ? 0 : 1, lane.order] : [2, 0]);

   // セクションから外れた連動タスクは、ボードに出ていないので出さない
   const rows = tasks.filter((t) => t.status !== 'todo' && t.startDate && !isUnassigned(t)).map((task) => {
      const start = task.startDate;
      // 終了日を空にしてある完了タスクは、完了した日で止める
      const fallback = task.status === 'done' && task.doneAt ? toDateString(new Date(task.doneAt)) : today;
      const end = task.endDate ?? fallback;
      return {
         task,
         lane: laneById.get(task.laneId) ?? null,
         start,
         end: end < start ? start : end, // 開始日を今日より後に直してあるとき
         ongoing: task.status !== 'done',
      };
   });

   const key = (row) => [row.ongoing ? 0 : 1, row.start, row.end, ...laneRank(row.lane), row.task.order];
   return rows.sort((a, b) => {
      const [ka, kb] = [key(a), key(b)];
      const i = ka.findIndex((v, n) => v !== kb[n]);
      return i < 0 ? 0 : ka[i] < kb[i] ? -1 : 1;
   });
}

/**
 * チャートに出す期間。いちばん早い開始日の数日前から、今日・締切・いちばん遅い終わりのうち最も遅い日の数日後まで。
 * @param {{ start: string, end: string }[]} rows
 * @param {string} today 今日(YYYY-MM-DD)
 * @param {string|null} [dueDate] プロジェクトの締切
 * @returns {{ from: string, days: number }} 最初の日と、日数
 */
export function ganttRange(rows, today, dueDate = null) {
   const dates = [today, ...rows.flatMap((r) => [r.start, r.end]), ...(dueDate ? [dueDate] : [])].sort();
   const from = addDays(dates[0], -RANGE_MARGIN);
   return { from, days: daysBetween(from, dates.at(-1)) + RANGE_MARGIN + 1 };
}
