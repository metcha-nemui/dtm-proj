// 作業タイマー(アレンジ画面)の順番。進行中のクリップを1つずつ「いまの作業対象」にして、決めた時間ごとに次へ回す。
// 対象は、連動タスクが作業中のクリップ(セクションの外のものは、ボードに出ていないので除く)。
// 順番は曲の頭から(同じ小節ならトラックの並び順)。最後まで行ったら頭に戻る。

import { clipSection } from './arrangement.js';
import { sortByOrder } from './order.js';

/**
 * 作業する順に並べた、進行中のクリップ。
 * @returns {Array<{ clipId: string, taskId: string, title: string, startBar: number, trackIndex: number }>}
 */
export function workQueue({ tracks, clips, tasks, markers }) {
   const trackIndex = new Map(sortByOrder(tracks).map((t, i) => [t.id, i]));
   const doing = new Map(tasks.filter((t) => t.clipId && t.status === 'doing').map((t) => [t.clipId, t]));
   return clips
      .filter((c) => doing.has(c.id) && trackIndex.has(c.trackId) && clipSection(c, markers) !== null)
      .map((c) => ({
         clipId: c.id,
         taskId: doing.get(c.id).id,
         title: doing.get(c.id).title,
         startBar: c.startBar,
         trackIndex: trackIndex.get(c.trackId),
      }))
      .sort(comparePlace);
}

const comparePlace = (a, b) => a.startBar - b.startBar || a.trackIndex - b.trackIndex;

/**
 * current の次の作業対象。current より後ろの位置にある最初のもので、なければ頭に戻る(1つしかなければ同じもの)。
 * current はもう対象でない(完了した・消えた)ものでもよい(覚えておいた位置の次から探す)。null なら先頭。
 * @returns {object|null} 対象がなければ null
 */
export function nextWork(queue, current) {
   if (!current) return queue[0] ?? null;
   return queue.find((w) => comparePlace(w, current) > 0) ?? queue[0] ?? null;
}
