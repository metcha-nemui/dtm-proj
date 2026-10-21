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
   const { a, b, c, s, linkedTo } = doingFixture();
   const queue = workQueue(s);
   equal(queue.map((w) => w.clipId), [a.id, b.id, c.id]);
   equal(queue[0].title, 'シンセ: イントロ', 'タスク名を出す');
   equal(queue[0].taskId, linkedTo(s, a).id);
   const done = { ...s, tasks: apply(s.tasks, [setStatus(linkedTo(s, b), 'done'), setStatus(linkedTo(s, c), 'todo')]) };
   equal(workQueue(done).map((w) => w.clipId), [a.id], '完了・未着手は除く');
   equal(workQueue({ ...s, markers: s.markers.slice(1) }).map((w) => w.clipId), [b.id, c.id], 'セクションの外は除く');
   const plain = { ...s, tasks: s.tasks.map((t) => (t.clipId ? t : { ...t, status: 'doing' })) };
   equal(workQueue(plain).length, 3, 'ふつうのタスクは入らない');
});

test('nextWork: 次の位置のものへ進み、最後まで行ったら頭に戻る。対象でなくなったものの次からも探せる', () => {
   const { a, b, c, s, synth } = doingFixture();
   const queue = workQueue(s);
   const at = (id) => queue.find((w) => w.clipId === id);
   equal(nextWork(queue, null)?.clipId, a.id, '最初は先頭');
   equal(nextWork(queue, at(a.id))?.clipId, b.id);
   equal(nextWork(queue, at(b.id))?.clipId, c.id, '同じ小節の次のトラック');
   equal(nextWork(queue, at(c.id))?.clipId, a.id, '頭に戻る');
   equal(nextWork(queue.slice(0, 1), at(a.id))?.clipId, a.id, '1つなら同じもの');
   const gone = { ...at(a.id), clipId: 'gone', startBar: 5 };
   equal(nextWork(queue, gone)?.clipId, b.id, '消えたものの位置の次');
   equal(nextWork([], at(a.id)), null, '対象がない');
   const later = addClip(synth, s.clips, { startBar: 13, bars: 1 });
   equal(nextWork(workQueue({ ...s, clips: [...s.clips, later] }), at(c.id))?.clipId, a.id, '作業中でないクリップは飛ばす');
});
