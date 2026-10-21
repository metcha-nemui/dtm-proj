// 作業タイマー(アレンジ画面)の順番。進行中のクリップを1つずつ「いまの作業対象」にして、決めた時間ごとに次へ進める。
// 対象は、連動タスクが作業中のクリップ(セクションの外のものは、ボードに出ていないので除く)。
// 順番は始めるときに決める(初めは曲の頭から、同じ小節ならトラックの並び順。それを入れ替えられる)。最後まで行ったら終わる。

import { clipSection } from './arrangement.js';
import { sortByOrder } from './order.js';

/**
 * 進行中のクリップを、曲の頭から(同じ小節ならトラックの並び順に)並べる。
 * @returns {Array<{ clipId: string, taskId: string, title: string }>}
 */
export function workQueue({ tracks, clips, tasks, markers }) {
   const trackIndex = new Map(sortByOrder(tracks).map((t, i) => [t.id, i]));
   const doing = new Map(tasks.filter((t) => t.clipId && t.status === 'doing').map((t) => [t.clipId, t]));
   return clips
      .filter((c) => doing.has(c.id) && trackIndex.has(c.trackId) && clipSection(c, markers) !== null)
      .sort((a, b) => a.startBar - b.startBar || trackIndex.get(a.trackId) - trackIndex.get(b.trackId))
      .map((c) => ({ clipId: c.id, taskId: doing.get(c.id).id, title: doing.get(c.id).title }));
}

/**
 * 作業する順(clipId の並び)で、currentId の次の作業対象。もう作業中でないもの(queue にない)は飛ばす。
 * currentId が null なら最初のもの。
 * @param {string[]} order 始めるときに決めた順
 * @param {object[]} queue いまの workQueue
 * @returns {object|null} 最後まで行ったら null(頭には戻らない)
 */
export function nextWork(order, queue, currentId = null) {
   const doing = new Map(queue.map((w) => [w.clipId, w]));
   const from = currentId == null ? 0 : order.indexOf(currentId) + 1;
   return order.slice(from).map((id) => doing.get(id)).find(Boolean) ?? null;
}
