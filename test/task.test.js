// タスクと進捗の集計のテスト。test/domain.test.js から読む。

import { duplicateLane } from '../js/domain/project.js';
import { summarize, summarizeByLane } from '../js/domain/stats.js';
import { addTask, cycleStatus, isValidPeriod, setStatus, updateTask } from '../js/domain/task.js';
import { test, assert, equal, throws, titles, fixture } from './helpers.js';

// ---- task ----

test('addTask: 末尾に追加', () => {
   const { tasks, lane, inLane } = fixture();
   const task = addTask(lane('サビ'), inLane(tasks, 'サビ'), ' ギターソロ ');
   equal([task.title, task.status], ['ギターソロ', 'todo']);
   equal(titles(inLane([...tasks, task], 'サビ')).at(-1), 'ギターソロ');
   throws(() => addTask(lane('サビ'), [], '   '));
});

test('cycleStatus: todo → doing → done → todo、doneAt を記録', () => {
   const { tasks } = fixture();
   const doing = cycleStatus(tasks[0]);
   equal([doing.status, doing.doneAt], ['doing', null]);
   const done = cycleStatus(doing);
   equal(done.status, 'done');
   assert(typeof done.doneAt === 'string' && !Number.isNaN(Date.parse(done.doneAt)));
   const todo = cycleStatus(done);
   equal([todo.status, todo.doneAt], ['todo', null]);
   equal(tasks[0].status, 'todo', '元のレコードは変更しない');
});

test('updateTask: タイトルとメモを編集、空タイトルは拒否', () => {
   const { tasks } = fixture();
   const t = updateTask(tasks[0], { title: ' 新 ', memo: 'a\nb' });
   equal([t.title, t.memo], ['新', 'a\nb']);
   throws(() => updateTask(tasks[0], { title: '' }));
});

test('開始日と終了日(実績): ステータスを変えたときに自動で入り、未着手に戻すと消える', () => {
   const { tasks, lane } = fixture();
   const dates = (t) => [t.startDate, t.endDate];
   const day = (d) => new Date(2026, 9, d, 23, 30);
   equal(dates(tasks[0]), [null, null], '初めは日付なし');
   equal(dates(addTask(lane('サビ'), [], 'x')), [null, null]);

   const doing = setStatus(tasks[0], 'doing', day(20));
   equal(dates(doing), ['2026-10-20', null], '着手した日(端末の日付)');
   const done = setStatus(doing, 'done', day(25));
   equal(dates(done), ['2026-10-20', '2026-10-25'], '開始日は残り、終了日が入る');
   equal(dates(setStatus(done, 'doing', day(27))), ['2026-10-20', null], '完了を取り消すと終了日は消える');
   equal(dates(setStatus(done, 'todo', day(27))), [null, null], '未着手に戻すとどちらも消える');
   equal(dates(setStatus(doing, 'todo', day(21))), [null, null]);
   equal(dates(setStatus(tasks[0], 'done', day(25))), ['2026-10-25', '2026-10-25'], '未着手から直接完了');
   equal(dates(tasks[0]), [null, null], '元のレコードは変更しない');

   // 丸のクリックで一周すると、開始日は入り直す
   const again = cycleStatus(cycleStatus(cycleStatus(doing)));
   equal([again.status, again.endDate, again.startDate !== null], ['doing', null, true]);

   // 開始日を今日より後に直してあったら、終了日は開始日に合わせる
   const future = updateTask(doing, { startDate: '2026-10-30' });
   equal(dates(setStatus(future, 'done', day(25))), ['2026-10-30', '2026-10-30']);

   // 日付を持つ前に作ったタスク(項目がない)でも同じ
   const { startDate, endDate, ...old } = tasks[0];
   equal(dates(setStatus(old, 'doing', day(20))), ['2026-10-20', null]);
});

test('開始日と終了日(実績): 手で直せるのは、着手後の開始日と、完了後の終了日だけ', () => {
   const { tasks } = fixture();
   const doing = setStatus(tasks[0], 'doing', new Date(2026, 9, 20));
   const done = setStatus(doing, 'done', new Date(2026, 9, 25));

   throws(() => updateTask(tasks[0], { startDate: '2026-10-20' }), '未着手に開始日');
   throws(() => updateTask(tasks[0], { endDate: '2026-10-20' }), '未着手に終了日');
   throws(() => updateTask(doing, { endDate: '2026-10-25' }), '作業中に終了日');
   equal(updateTask(tasks[0], { startDate: '', endDate: null }).startDate, null, '空を入れるのはよい');

   equal(updateTask(doing, { startDate: '2026-10-18' }).startDate, '2026-10-18');
   const fixed = updateTask(done, { startDate: '2026-10-18', endDate: '2026-10-24' });
   equal([fixed.startDate, fixed.endDate], ['2026-10-18', '2026-10-24']);
   equal(updateTask(done, { title: 'y' }).endDate, '2026-10-25', '他の項目だけ編集しても消えない');
   equal(updateTask(done, { endDate: '2026-10-20' }).endDate, '2026-10-20', '同じ日でもよい');
   const cleared = updateTask(done, { startDate: '', endDate: '2026-02-30' });
   equal([cleared.startDate, cleared.endDate], [null, null], '空や不正な日付は日付なし');

   throws(() => updateTask(done, { endDate: '2026-10-19' }), '終了日が開始日より前');
   throws(() => updateTask(done, { startDate: '2026-10-26' }), '開始日が終了日より後');
   updateTask(done, { startDate: '2026-11-01', endDate: '2026-11-03' });
   assert(isValidPeriod(null, '2026-10-01') && isValidPeriod('2026-10-01', null) && !isValidPeriod('2026-10-02', '2026-10-01'));
});

test('開始日と終了日: セクションの複製には引き継がない', () => {
   const { lanes, tasks } = fixture();
   const dated = tasks.map((t) => setStatus(t, 'done'));
   assert(dated.every((t) => t.startDate && t.endDate));
   const noDates = (list) => list.length > 0 && list.every((t) => t.startDate === null && t.endDate === null);
   const chorus = lanes.find((l) => l.name === 'サビ');
   assert(noDates(duplicateLane(chorus.id, lanes, dated).tasks), 'セクションの複製');
});

// ---- stats ----

test('summarize: 完了数と進捗率', () => {
   const tasks = [{ status: 'done' }, { status: 'doing' }, { status: 'todo' }, { status: 'todo' }];
   equal(summarize(tasks), { total: 4, done: 1, doing: 1, ratio: 0.25 });
   equal(summarize([]), { total: 0, done: 0, doing: 0, ratio: 0 });
});

test('summarizeByLane', () => {
   const { lanes, tasks, lane } = fixture();
   const byLane = summarizeByLane(lanes, tasks);
   equal(byLane.get(lane('サビ').id).total, 6);
   equal(byLane.get(lane('イントロ').id).total, 0);
});
