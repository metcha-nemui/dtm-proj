// 作業タイマーの順番のテスト。test/domain.test.js から読む。

import { addClip } from '../js/domain/arrangement.js';
import { setStatus } from '../js/domain/task.js';
import { nextWork, workQueue } from '../js/domain/work.js';
import { test, equal, apply, linkedFixture } from './helpers.js';

// a(シンセ・1小節目)、b(シンセ・9小節目)、c(ドラム・9小節目)を作業中にした状態
function doingFixture() {
   const f = linkedFixture();
   let s = f.sync(f.state);
   s = { ...s, tasks: apply(s.tasks, [f.a, f.b, f.c].map((clip) => setStatus(f.linkedTo(s, clip), 'doing'))) };
   return { ...f, s };
}

test('workQueue: 作業中の連動タスクのクリップを、曲の頭から(同じ小節ならトラック順に)並べる', () => {
   const { a, b, c, s, linkedTo, synth } = doingFixture();
   const queue = workQueue(s);
   equal(queue.map((w) => w.clipId), [a.id, b.id, c.id]);
   equal(queue[0].title, 'シンセ: イントロ', 'タスク名を出す');
   equal(queue[0].taskId, linkedTo(s, a).id);
   const done = { ...s, tasks: apply(s.tasks, [setStatus(linkedTo(s, b), 'done'), setStatus(linkedTo(s, c), 'todo')]) };
   equal(workQueue(done).map((w) => w.clipId), [a.id], '完了・未着手は除く');
   equal(workQueue({ ...s, markers: s.markers.slice(1) }).map((w) => w.clipId), [b.id, c.id], 'セクションの外は除く');
   const plain = { ...s, tasks: s.tasks.map((t) => (t.clipId ? t : { ...t, status: 'doing' })) };
   equal(workQueue(plain).length, 3, 'ふつうのタスクは入らない');
   const later = addClip(synth, s.clips, { startBar: 13, bars: 1 });
   equal(workQueue({ ...s, clips: [...s.clips, later] }).length, 3, '連動タスクが作業中でないクリップは入らない');
});

test('nextWork: 決めた順で次へ進み、作業中でなくなったものは飛ばし、最後まで行ったら終わる', () => {
   const { a, b, c, s, linkedTo } = doingFixture();
   const queue = workQueue(s);
   const order = [c.id, a.id, b.id]; // 始めるときに入れ替えた順
   equal(nextWork(order, queue)?.clipId, c.id, '最初は先頭');
   equal(nextWork(order, queue, c.id)?.clipId, a.id);
   equal(nextWork(order, queue, a.id)?.clipId, b.id);
   equal(nextWork(order, queue, b.id), null, '頭には戻らない');
   const done = workQueue({ ...s, tasks: apply(s.tasks, [setStatus(linkedTo(s, a), 'done')]) });
   equal(nextWork(order, done, c.id)?.clipId, b.id, '完了したものは飛ばす');
   equal(nextWork(order, done, a.id)?.clipId, b.id, 'いまの対象が完了しても、その次から');
   equal(nextWork(order, [], null), null, '対象がない');
});
