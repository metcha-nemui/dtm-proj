// 進捗の集計。

/**
 * タスクの集まり(レーン単位でもプロジェクト全体でも)を集計する。
 * @returns {{ total: number, done: number, doing: number, ratio: number }}
 */
export function summarize(tasks) {
   const stats = { total: tasks.length, done: 0, doing: 0, ratio: 0 };
   for (const task of tasks) {
      if (task.status === 'done') stats.done++;
      else if (task.status === 'doing') stats.doing++;
   }
   stats.ratio = stats.total ? stats.done / stats.total : 0;
   return stats;
}

/** すべてのタスクが完了しているか。タスクが1件もなければ完了とはみなさない。 */
export function isFinished(stats) {
   return stats.total > 0 && stats.done === stats.total;
}

/** レーンIDごとの集計を Map で返す。 */
export function summarizeByLane(lanes, tasks) {
   return new Map(lanes.map((lane) => [lane.id, summarize(tasks.filter((t) => t.laneId === lane.id))]));
}
