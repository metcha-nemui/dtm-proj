// 締切パネル・日付・ガントチャートのテスト。test/domain.test.js から読む。

import { addDays, daysBetween, toDateString, weekendDaysBetween } from '../js/domain/date.js';
import { deadlineRange, deadlineRows } from '../js/domain/deadline.js';
import { ganttRange, ganttRows } from '../js/domain/gantt.js';
import { isFinished } from '../js/domain/stats.js';
import { moveTask, setStatus } from '../js/domain/task.js';
import { test, equal, titles, apply, item, fixture } from './helpers.js';

// ---- deadline ----

test('isFinished: タスクがあり、すべて完了しているときだけ', () => {
   equal([
      isFinished({ total: 3, done: 3 }),
      isFinished({ total: 3, done: 2 }),
      isFinished({ total: 0, done: 0 }),
   ], [true, false, false]);
});

test('deadlineRows: 締切のある未完了のプロジェクトを、締切の早い順に(同じ日はタイトル順)', () => {
   const open = { total: 4, done: 1 };
   const item = (title, dueDate, stats = open) => ({ project: { id: title, title, dueDate }, stats });
   const items = [
      item('さくら', '2026-10-20'),
      item('締切なし', null),
      item('完了済み', '2026-10-14', { total: 2, done: 2 }),
      item('あおぞら', '2026-10-20'),
      item('過ぎた', '2026-10-10'),
      item('空のプロジェクト', '2026-11-01', { total: 0, done: 0 }),
   ];
   const rows = deadlineRows(items, '2026-10-15');
   equal(rows.map((r) => [r.project.title, r.days, r.weekendDays]),
      [['過ぎた', -5, 0], ['あおぞら', 5, 2], ['さくら', 5, 2], ['空のプロジェクト', 17, 6]]);
   equal(deadlineRows([item('完了済み', '2026-10-14', { total: 1, done: 1 })], '2026-10-15'), [], '出すものがなければ空');
});

test('weekendDaysBetween: 翌日から締切日までの土日を数える', () => {
   // 2026-10-15 は木曜、10-17 が土曜、10-18 が日曜
   equal([
      weekendDaysBetween('2026-10-15', '2026-10-16'), // 金
      weekendDaysBetween('2026-10-15', '2026-10-17'), // 土まで
      weekendDaysBetween('2026-10-15', '2026-10-18'), // 日まで
      weekendDaysBetween('2026-10-15', '2026-10-22'), // ちょうど1週
      weekendDaysBetween('2026-10-15', '2026-11-01'), // 2週と3日(日曜まで)
   ], [0, 1, 2, 2, 6]);
   equal([
      weekendDaysBetween('2026-10-17', '2026-10-18'), // 今日(土)は数えない
      weekendDaysBetween('2026-10-18', '2026-10-24'), // 日曜から次の土曜まで
   ], [1, 1]);
   equal([
      weekendDaysBetween('2026-10-15', '2026-10-15'),
      weekendDaysBetween('2026-10-20', '2026-10-15'),
   ], [0, 0], '今日と過ぎた日は 0');
   equal(weekendDaysBetween('2026-01-01', '2027-01-01'), 104, '1年(2027-01-01 は金曜)');
});

test('deadlineRange: 今日と全締切のうち、いちばん早い日からいちばん遅い日まで(前後に余白)', () => {
   const row = (dueDate) => ({ project: { dueDate } });
   equal(deadlineRange([row('2026-10-20'), row('2026-11-01')], '2026-10-15'), { from: '2026-10-12', days: 24 });
   equal(deadlineRange([row('2026-10-10')], '2026-10-15'), { from: '2026-10-07', days: 12 }, '過ぎた締切も入れる');
   equal(deadlineRange([row('2026-10-15')], '2026-10-15'), { from: '2026-10-12', days: 7 }, '今日が締切');
});

// ---- date / gantt ----

test('日付のヘルパー: 月や年をまたいで数える', () => {
   equal(toDateString(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
   equal([addDays('2026-10-30', 3), addDays('2026-01-01', -1), addDays('2028-02-28', 1)], ['2026-11-02', '2025-12-31', '2028-02-29']);
   equal([daysBetween('2026-10-13', '2026-10-13'), daysBetween('2026-10-30', '2026-11-02'), daysBetween('2026-11-02', '2026-10-30')], [0, 3, -3]);
   equal(daysBetween('2026-01-01', '2027-01-01'), 365);
});

test('ganttRows: 着手済みで開始日のあるタスクを、作業中を先に、開始日の早い順に出す', () => {
   const { tasks, lanes, lane, inLane } = fixture();
   const today = '2026-10-13';
   const day = (d) => new Date(2026, 9, d, 12);
   const [key, name, lyric] = inLane(tasks, '全体');
   const [chord, melody, drums] = inLane(tasks, 'サビ');
   const verse = inLane(tasks, 'Aメロ')[0];
   const all = apply(tasks, [
      setStatus(setStatus(chord, 'doing', day(5)), 'done', day(8)), // 10/5〜10/8
      setStatus(melody, 'doing', day(10)), // 10/10〜(作業中)
      setStatus(key, 'doing', day(5)), // 10/5〜(作業中)。同じ開始日なら、終わりの早い方が先
      setStatus(verse, 'done', day(10)), // 10/10 の1日だけ
      { ...setStatus(name, 'done', day(9)), startDate: '2026-10-07', endDate: null }, // 終了日を空にした完了
      { ...drums, startDate: '2026-10-01' }, // 未着手は、日付が残っていても出さない
      { ...setStatus(lyric, 'doing', day(6)), startDate: null }, // 開始日を空にした作業中
   ]);
   const rows = ganttRows(all, lanes, today);
   equal(rows.map((r) => [r.task.title, r.start, r.end, r.ongoing]), [
      ['テンポ・キー決定', '2026-10-05', today, true],
      ['メロ確定', '2026-10-10', today, true],
      ['コード確定', '2026-10-05', '2026-10-08', false],
      ['仮タイトル', '2026-10-07', '2026-10-09', false],
      ['コード確定', '2026-10-10', '2026-10-10', false],
   ]);
   equal([rows[2].lane.id, rows[4].lane.id], [lane('サビ').id, lane('Aメロ').id], 'レーンも返す');
   equal(ganttRows(tasks, lanes, today), [], '着手したタスクがなければ空');

   // 開始日も終了日も同じなら、ボードでの並び順(「全体」→ セクションの順 → レーン内の順)
   const sameDay = apply(tasks, [melody, key, verse, chord].map((t) => setStatus(t, 'done', day(10))));
   equal(ganttRows(sameDay, lanes, today).map((r) => `${r.lane.name}/${r.task.title}`),
      ['全体/テンポ・キー決定', 'Aメロ/コード確定', 'サビ/コード確定', 'サビ/メロ確定']);

   // 開始日を今日より後に直してある作業中のタスクは、開始日の1日分にする
   const future = ganttRows([{ ...setStatus(chord, 'doing', day(13)), startDate: '2026-10-20' }], lanes, today)[0];
   equal([future.start, future.end], ['2026-10-20', '2026-10-20']);
});

test('ganttRange: いちばん早い開始日から、今日・締切・終わりの遅い日まで(前後に余白)', () => {
   const rows = [{ start: '2026-10-05', end: '2026-10-08' }, { start: '2026-09-29', end: '2026-10-13' }];
   equal(ganttRange(rows, '2026-10-13'), { from: '2026-09-26', days: 21 });
   equal(ganttRange(rows, '2026-10-13', '2026-10-31'), { from: '2026-09-26', days: 39 }, '締切まで延ばす');
   equal(ganttRange(rows, '2026-10-13', '2026-09-01'), { from: '2026-08-29', days: 49 }, '過ぎた締切も入れる');
   equal(ganttRange([{ start: '2026-10-20', end: '2026-10-20' }], '2026-10-13'), { from: '2026-10-10', days: 14 });
});

test('moveTask: レーン内の並べ替え', () => {
   const { tasks, lane, inLane } = fixture();
   const first = inLane(tasks, 'Aメロ')[0];
   const changed = moveTask(tasks, first.id, lane('Aメロ').id, 2);
   equal(changed.length, 1);
   equal(titles(inLane(apply(tasks, changed), 'Aメロ')), ['メロ確定', 'ドラム', 'コード確定', 'ベース']);
});

test('moveTask: レーン間の移動', () => {
   const { tasks, lane, inLane } = fixture();
   const task = inLane(tasks, 'サビ')[5];
   const moved = apply(tasks, moveTask(tasks, task.id, lane('イントロ').id, 0));
   equal(titles(inLane(moved, 'イントロ')), ['コーラス']);
   equal(inLane(moved, 'サビ').length, 5);
   const again = apply(moved, moveTask(moved, task.id, lane('Aメロ').id, 1));
   equal(titles(inLane(again, 'Aメロ')), ['コード確定', 'コーラス', 'メロ確定', 'ドラム', 'ベース']);
});
