// タスクのドメインロジック。DOMにもrepositoryにも依存しない。
// 受け取ったレコードは変更せず、保存すべき新しいレコードを返す。

import { normalizeDate, toDateString } from './date.js';
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
      startDate: null,
      endDate: null,
      ...fields,
   });
}

/** タスクをレーンの末尾に追加する。 */
export function addTask(lane, laneTasks, title) {
   const trimmed = title.trim();
   if (!trimmed) throw new Error('タイトルを入力してください');
   return newTask(lane, { title: trimmed, order: orderAtEnd(laneTasks) });
}

/**
 * タスクをコピーする(レーンの複製、テンプレートとのやり取り用)。ステータスは未着手に戻し、メモは引き継ぐ。
 * 開始日・終了日は引き継がない。日付は作業の実績で、未着手に戻したコピーには当てはまらないため。
 */
export function copyTask(task, lane) {
   return newTask(lane, {
      title: task.title,
      memo: task.memo,
      order: task.order,
   });
}

/** 開始日と終了日の両方があるとき、終了日が開始日より前になっていないか。 */
export function isValidPeriod(startDate, endDate) {
   return !startDate || !endDate || startDate <= endDate;
}

/**
 * タイトル・メモ・開始日・終了日を編集する。日付は 'YYYY-MM-DD'。空や不正な日付は null(日付なし)。
 * 日付は実績(着手した日・終わった日)で、ふつうは setStatus が入れる。ここでは、その修正だけを受け付ける。
 * だから、未着手のタスクに開始日は入れられず、完了していないタスクに終了日は入れられない。
 */
export function updateTask(task, patch) {
   const next = {};
   if ('title' in patch) {
      const title = patch.title.trim();
      if (!title) throw new Error('タイトルを入力してください');
      next.title = title;
   }
   if ('memo' in patch) next.memo = patch.memo;
   if ('startDate' in patch) next.startDate = normalizeDate(patch.startDate);
   if ('endDate' in patch) next.endDate = normalizeDate(patch.endDate);
   if (next.startDate && task.status === 'todo') throw new Error('未着手のタスクに開始日は入れられません');
   if (next.endDate && task.status !== 'done') throw new Error('完了していないタスクに終了日は入れられません');
   // 日付を持つ前に作ったタスクには項目がないので、null として扱う
   const period = { startDate: task.startDate ?? null, endDate: task.endDate ?? null, ...next };
   if (!isValidPeriod(period.startDate, period.endDate)) throw new Error('終了日は開始日以降にしてください');
   return touch(task, next);
}

/**
 * ステータスを変える。done にしたときに doneAt を記録し、done から戻したら消す。
 * 開始日と終了日(実績)も、ステータスに合わせて入れる。
 * - 作業中: 開始日が空なら今日。終了日はなし
 * - 完了: 終了日は今日。開始日が空なら(未着手から直接)開始日も今日
 * - 未着手: どちらもなし
 */
export function setStatus(task, status, now = new Date()) {
   if (!STATUSES.includes(status)) throw new Error(`不正なステータス: ${status}`);
   if (task.status === status) return task;
   const today = toDateString(now);
   const startDate = status === 'todo' ? null : task.startDate ?? today;
   // 開始日を今日より後に直してあったときは、終了日が開始日より前にならないように合わせる
   const endDate = status === 'done' ? (startDate > today ? startDate : today) : null;
   return touch(task, { status, doneAt: status === 'done' ? now.toISOString() : null, startDate, endDate });
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
