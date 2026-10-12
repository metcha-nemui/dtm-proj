// タスクのドメインロジック。DOMにもrepositoryにも依存しない。
// 受け取ったレコードは変更せず、保存すべき新しいレコードを返す。

import { orderAtEnd, placeAt } from './order.js';
import { newRecord, touch } from './record.js';

export const STATUSES = ['todo', 'doing', 'done'];
export const STATUS_LABELS = { todo: '未着手', doing: '作業中', done: '完了' };

function newTask(lane, fields) {
   return newRecord({
      projectId: lane.projectId,
      laneId: lane.id,
      title: '',
      memo: '',
      status: 'todo',
      order: 0,
      doneAt: null,
      ...fields,
   });
}

/** タスクをレーンの末尾に追加する。 */
export function addTask(lane, laneTasks, title) {
   const trimmed = title.trim();
   if (!trimmed) throw new Error('タイトルを入力してください');
   return newTask(lane, { title: trimmed, order: orderAtEnd(laneTasks) });
}

/** タスクをコピーする(レーン複製用)。ステータスは未着手に戻し、メモは引き継ぐ。 */
export function copyTask(task, lane) {
   return newTask(lane, {
      title: task.title,
      memo: task.memo,
      order: task.order,
   });
}

/** タイトルとメモを編集する。 */
export function updateTask(task, patch) {
   const next = {};
   if ('title' in patch) {
      const title = patch.title.trim();
      if (!title) throw new Error('タイトルを入力してください');
      next.title = title;
   }
   if ('memo' in patch) next.memo = patch.memo;
   return touch(task, next);
}

/** ステータスを変える。done にしたときに doneAt を記録し、done から戻したら消す。 */
export function setStatus(task, status) {
   if (!STATUSES.includes(status)) throw new Error(`不正なステータス: ${status}`);
   if (task.status === status) return task;
   return touch(task, { status, doneAt: status === 'done' ? new Date().toISOString() : null });
}

/** todo → doing → done → todo と循環させる。 */
export function cycleStatus(task) {
   return setStatus(task, STATUSES[(STATUSES.indexOf(task.status) + 1) % STATUSES.length]);
}

/**
 * タスクを toLaneId の toIndex 番目(自身を除いた並びでの位置)に動かす。
 * レーン内の並べ替えにも、レーン間の移動にも使う。変更のあったタスクを返す。
 */
export function moveTask(tasks, taskId, toLaneId, toIndex) {
   const task = tasks.find((t) => t.id === taskId);
   if (!task) return [];
   const siblings = tasks.filter((t) => t.laneId === toLaneId && t.id !== taskId);
   return placeAt(siblings, { ...task, laneId: toLaneId }, toIndex).map((t) => touch(t));
}
