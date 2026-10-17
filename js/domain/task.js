// タスクのドメインロジック。DOMにもrepositoryにも依存しない。
// 受け取ったレコードは変更せず、保存すべき新しいレコードを返す。

import { normalizeDate, toDateString } from './date.js';
import { orderAtEnd, placeAt } from './order.js';
import { newRecord, touch } from './record.js';
import { cleanReferences } from './reference.js';

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
      references: [],
      clipId: null, // アレンジのクリップから作った連動タスクなら、そのクリップのID
      ...fields,
   });
}

/**
 * マーカーの削除・移動でセクションから外れた連動タスク(laneId がない)。
 * ステータスと日付を残しておくために持っているだけで、ボードにも集計にも出さない。
 */
export const isUnassigned = (task) => Boolean(task.clipId) && !task.laneId;

/** タスクをレーンの末尾に追加する。 */
export function addTask(lane, laneTasks, title) {
   const trimmed = title.trim();
   if (!trimmed) throw new Error('タイトルを入力してください');
   return newTask(lane, { title: trimmed, order: orderAtEnd(laneTasks) });
}

/**
 * アレンジのクリップから、連動タスクをレーンの末尾に作る。title と memo はクリップから写したもの。
 * @param {object[]} laneTasks レーンのタスク
 */
export function addClipTask(lane, laneTasks, clipId, { title, memo }) {
   return newTask(lane, { clipId, title, memo, order: orderAtEnd(laneTasks) });
}

/**
 * タスクをコピーする(レーンの複製用)。ステータスは未着手に戻し、メモは引き継ぐ。
 * 開始日・終了日は引き継がない。日付は作業の実績で、未着手に戻したコピーには当てはまらないため。
 * リファレンスは曲ごとのものなので、ふつうは引き継がない。
 * 同じプロジェクトの中でのコピー(セクションの複製)だけ、keepReferences で引き継ぐ。
 */
export function copyTask(task, lane, { keepReferences = false } = {}) {
   return newTask(lane, {
      title: task.title,
      memo: task.memo,
      order: task.order,
      references: keepReferences ? [...(task.references ?? [])] : [],
   });
}

/** 開始日と終了日の両方があるとき、終了日が開始日より前になっていないか。 */
export function isValidPeriod(startDate, endDate) {
   return !startDate || !endDate || startDate <= endDate;
}

/**
 * タイトル・メモ・開始日・終了日・リファレンスを編集する。日付は 'YYYY-MM-DD'。空や不正な日付は null(日付なし)。
 * リファレンスは曲名の配列で、空のものと、表記の違いだけで同じものは落とす。
 * 日付は実績(着手した日・終わった日)で、ふつうは setStatus が入れる。ここでは、その修正だけを受け付ける。
 * だから、未着手のタスクに開始日は入れられず、完了していないタスクに終了日は入れられない。
 */
export function updateTask(task, patch) {
   const next = {};
   if ('title' in patch) {
      // 連動タスクのタイトルは「トラック名: クリップ名」から作る。名前はクリップの方で直す
      if (task.clipId) throw new Error('アレンジのクリップから来たタスクの名前は、クリップの名前で変えてください');
      const title = patch.title.trim();
      if (!title) throw new Error('タイトルを入力してください');
      next.title = title;
   }
   if ('memo' in patch) next.memo = patch.memo;
   if ('references' in patch) next.references = cleanReferences(patch.references);
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
   // 連動タスクのセクションは、アレンジのマーカーとクリップの位置で決まる
   if (task.clipId && toLaneId !== task.laneId) throw new Error('アレンジのクリップから来たタスクは、ほかのセクションへ動かせません');
   const siblings = tasks.filter((t) => t.laneId === toLaneId && t.id !== taskId);
   return placeAt(siblings, { ...task, laneId: toLaneId }, toIndex).map((t) => touch(t));
}
