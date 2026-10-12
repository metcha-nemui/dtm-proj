// ドメインロジックと保存まわりの簡易テスト。test.html をブラウザで開くと実行される。
// Node でも動く: node -e "import('./test/domain.test.js').then(m => m.report()).then(ok => process.exit(ok ? 0 : 1))"

import {
   moveTemplateTask, newKind, newStructure, newTemplateTask, removeKind, updateKind, updateStructure, updateTemplateTask,
} from '../js/domain/library.js';
import { orderAtEnd, orderBetween, placeAt, reorder, sortByOrder } from '../js/domain/order.js';
import {
   addSection, assertSection, colorsInOrder, createProject, daysUntilDue, duplicateLane, moveLane, normalizeDueDate, renameLane,
   SECTION_COLORS, sectionColors, templatesFor, uniqueLaneName, updateProject,
} from '../js/domain/project.js';
import { summarize, summarizeByLane } from '../js/domain/stats.js';
import {
   addTask, cycleStatus, moveTask, promoteTask, setStatus, updateTask,
} from '../js/domain/task.js';
import { normalizeProjectUrl } from '../js/session.js';
import { buildSeed, ensureSeeded } from '../js/store/seed.js';
import { checkConnection, createSupabaseRepository, fromRow, toRow } from '../js/store/supabase.js';
import { migrate, SCHEMA_VERSION } from '../js/store/repository.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function assert(condition, message = 'assertion failed') {
   if (!condition) throw new Error(message);
}

function equal(actual, expected, label = '') {
   const a = JSON.stringify(actual);
   const e = JSON.stringify(expected);
   assert(a === e, `${label ? `${label}: ` : ''}expected ${e}, got ${a}`);
}

function throws(fn, label = 'should throw') {
   try {
      fn();
   } catch {
      return;
   }
   throw new Error(label);
}

// promise が、message に part を含むエラーで失敗することを確かめる
async function rejects(promise, part) {
   try {
      await promise;
   } catch (error) {
      assert(error.message.includes(part), `expected error containing "${part}", got "${error.message}"`);
      return;
   }
   throw new Error(`should reject: ${part}`);
}

const library = buildSeed();
const structure = (key) => library.structures.find((s) => s.id === `seed-structure-${key}`);
const kind = (key) => library.kinds.find((k) => k.id === `seed-kind-${key}`);
const titles = (items) => sortByOrder(items).map((i) => i.title ?? i.name);
const ids = (items) => sortByOrder(items).map((i) => i.id);
const apply = (items, changed) => items.map((i) => changed.find((c) => c.id === i.id) ?? i);
const item = (id, order) => ({ id, order });

// ---- order ----

test('orderBetween: 先頭・末尾・中間', () => {
   equal(orderBetween(null, null), 1);
   equal(orderBetween(null, 4), 3);
   equal(orderBetween(4, null), 5);
   equal(orderBetween(1, 2), 1.5);
});

test('orderAtEnd: 最大値の次', () => {
   equal(orderAtEnd([]), 1);
   equal(orderAtEnd([item('a', 1), item('b', 7.5)]), 8.5);
});

test('placeAt: 通常は1件だけ書き換える', () => {
   const list = [item('a', 1), item('b', 2), item('c', 3)];
   equal(placeAt(list, item('x', 0), 1), [{ id: 'x', order: 1.5 }]);
   equal(placeAt(list, item('x', 0), 0), [{ id: 'x', order: 0 }]);
   equal(placeAt(list, item('x', 0), 99), [{ id: 'x', order: 4 }]);
   equal(placeAt([], item('x', 0), 0), [{ id: 'x', order: 1 }]);
});

test('placeAt: 同じorderが並んでいたら全体を振り直す', () => {
   const list = [item('a', 1), item('b', 1), item('c', 1)];
   const changed = placeAt(list, item('x', 0), 1);
   equal(ids(apply([...list, item('x', 0)], changed)), ['a', 'x', 'b', 'c']);
});

test('placeAt: 精度が尽きても順序が壊れない', () => {
   let list = [item('a', 1), item('b', 2)];
   for (let n = 0; n < 200; n++) {
      const x = item(`x${n}`, 0);
      list = apply([...list, x], placeAt(list, x, 1));
      equal(ids(list)[1], `x${n}`, `${n}回目`);
   }
   assert(new Set(list.map((i) => i.order)).size === list.length, 'orderが重複している');
});

test('reorder: 自身を除いた位置で動かす', () => {
   const list = [item('a', 1), item('b', 2), item('c', 3)];
   equal(ids(apply(list, reorder(list, 'a', 2))), ['b', 'c', 'a']);
   equal(ids(apply(list, reorder(list, 'c', 0))), ['c', 'a', 'b']);
   equal(ids(apply(list, reorder(list, 'b', 1))), ['a', 'b', 'c']);
});

// ---- project ----

test('uniqueLaneName: 重複したら番号を振る', () => {
   equal(uniqueLaneName('Aメロ', []), 'Aメロ');
   equal(uniqueLaneName('Aメロ', ['Aメロ']), 'Aメロ2');
   equal(uniqueLaneName('Aメロ', ['Aメロ', 'Aメロ2']), 'Aメロ3');
});

test('createProject: 歌モノ標準からレーンとタスクができる', () => {
   const { project, lanes, tasks } = createProject({ title: ' 新曲 ' }, structure('vocal'), library);
   equal(project.title, '新曲');
   equal(titles(lanes.filter((l) => l.type === 'section')),
      ['イントロ', 'Aメロ', 'Bメロ', 'サビ', '間奏', 'Aメロ2', 'Bメロ2', 'サビ2', 'Cメロ', 'サビ3', 'アウトロ']);
   equal(titles(lanes.filter((l) => l.type === 'global')), ['全体']);
   assert(lanes.every((l) => l.projectId === project.id && l.collapsed === false));

   const chorus = lanes.find((l) => l.name === 'サビ2');
   equal(titles(tasks.filter((t) => t.laneId === chorus.id)),
      ['コード確定', 'メロ確定', 'ドラム', 'ベース', '上モノ', 'コーラス']);
   const global = lanes.find((l) => l.type === 'global');
   equal(titles(tasks.filter((t) => t.laneId === global.id)),
      ['テンポ・キー決定', '仮タイトル', '歌詞', 'ミックス', 'マスタリング', '書き出し']);
   assert(tasks.every((t) => t.status === 'todo'));
   assert(tasks.every((t) => !('origin' in t) && !('sourceTemplateTaskId' in t)), '出自は持たない');
   assert(tasks.every((t) => t.projectId === project.id));
   equal(tasks.length, 6 * 3 + 4 * 2 + 6);
});

test('createProject: 「全体」レーンは構成テンプレートに関係なく必ず1本できる', () => {
   for (const s of [structure('vocal'), structure('inst'), null, { sections: [] }]) {
      const { lanes, tasks } = createProject({ title: 'x' }, s, library);
      const globals = lanes.filter((l) => l.type === 'global');
      equal(globals.map((l) => [l.name, l.kindId]), [['全体', null]]);
      equal(tasks.filter((t) => t.laneId === globals[0].id).length, 6);
   }
   const none = createProject({ title: '' }, null, library);
   equal(none.project.title, '無題のプロジェクト');
   equal([none.lanes.length, none.tasks.length], [1, 6]);
});

test('「全体」レーンは名前変更・複製・削除できない', () => {
   const { lanes, tasks } = createProject({ title: 'x' }, structure('inst'), library);
   const global = lanes.find((l) => l.type === 'global');
   throws(() => renameLane(global, 'ミックス'), '名前変更');
   throws(() => duplicateLane(global.id, lanes, tasks), '複製');
   throws(() => assertSection(global, '削除'), '削除');
   assertSection(lanes.find((l) => l.type === 'section'), '削除');
});

test('createProject: コピー方式なのでライブラリを変えても影響しない', () => {
   const lib = buildSeed();
   const { tasks } = createProject({ title: 'x' }, lib.structures[0], lib);
   lib.templateTasks[0].title = '変更後';
   assert(tasks.every((t) => t.title !== '変更後'));
});

test('createProject: 削除済みの種別は飛ばす', () => {
   const s = { sections: ['seed-kind-chorus', 'gone', 'seed-kind-verse'] };
   const { lanes, tasks } = createProject({ title: 'x' }, s, library);
   equal(titles(lanes.filter((l) => l.type === 'section')), ['サビ', 'Aメロ']);
   equal(tasks.length, 10 + 6);
});

test('updateProject: 空タイトルは拒否', () => {
   const { project } = createProject({ title: 'x' }, null, library);
   equal(updateProject(project, { title: ' y ', memo: 'm' }).title, 'y');
   throws(() => updateProject(project, { title: '  ' }));
});

test('締切: 作成・編集で持てる。空や不正な日付は締切なし', () => {
   equal(createProject({ title: 'x' }, null, library).project.dueDate, null);
   const { project } = createProject({ title: 'x', dueDate: '2026-10-31' }, null, library);
   equal(project.dueDate, '2026-10-31');
   equal(updateProject(project, { dueDate: '2026-11-05' }).dueDate, '2026-11-05');
   equal(updateProject(project, { dueDate: '' }).dueDate, null);
   equal(updateProject(project, { title: 'y' }).dueDate, '2026-10-31', '他の項目だけ編集しても消えない');
   equal(['2026-02-30', '2026/10/31', 'abc', null, undefined].map(normalizeDueDate), [null, null, null, null, null]);
});

test('daysUntilDue: 端末の日付で数える', () => {
   const today = new Date(2026, 9, 12, 23, 30);
   equal([daysUntilDue('2026-10-12', today), daysUntilDue('2026-10-13', today), daysUntilDue('2026-10-31', today)], [0, 1, 19]);
   equal([daysUntilDue('2026-10-09', today), daysUntilDue('2027-01-01', today), daysUntilDue(null, today)], [-3, 81, null]);
   equal(daysUntilDue('2026-10-13', new Date(2026, 9, 12, 0, 0)), 1, '時刻によらない');
});

test('addSection: 指定位置に定番タスクつきで入る', () => {
   const { project, lanes } = createProject({ title: 'x' }, structure('vocal'), library);
   const added = addSection({
      projectId: project.id, lanes, kind: kind('chorus'), templateTasks: library.templateTasks, index: 1,
   });
   equal(added.lane.name, 'サビ4');
   equal(added.lanes.length, 1, '他のレーンは書き換えない');
   equal(added.tasks.length, 6);
   assert(added.tasks.every((t) => t.laneId === added.lane.id));
   const sections = [...lanes, added.lane].filter((l) => l.type === 'section');
   equal(titles(sections).slice(0, 3), ['イントロ', 'サビ4', 'Aメロ']);
});

test('addSection: 空で追加 / 末尾に追加 / 種別なし', () => {
   const { project, lanes } = createProject({ title: 'x' }, structure('inst'), library);
   const base = { projectId: project.id, lanes, templateTasks: library.templateTasks };
   const empty = addSection({ ...base, kind: kind('chorus'), empty: true });
   equal(empty.tasks.length, 0);
   equal(titles([...lanes, empty.lane].filter((l) => l.type === 'section')).at(-1), 'サビ');
   const noKind = addSection({ ...base, kind: null, name: ' ブレイク ' });
   equal([noKind.lane.name, noKind.lane.kindId, noKind.tasks.length], ['ブレイク', null, 0]);
});

test('duplicateLane: タスクごと複製し、ステータスは未着手に戻す', () => {
   const { lanes, tasks } = createProject({ title: 'x' }, structure('vocal'), library);
   const source = lanes.find((l) => l.name === 'サビ');
   const worked = tasks.map((t, i) => (t.laneId === source.id
      ? { ...setStatus(t, i % 2 ? 'done' : 'doing'), memo: 'メモ' }
      : t));
   const dup = duplicateLane(source.id, lanes, worked);
   equal(dup.lane.name, 'サビ4');
   equal(dup.lane.kindId, source.kindId);
   equal(dup.tasks.length, 6);
   assert(dup.tasks.every((t) => t.status === 'todo' && t.doneAt === null && t.memo === 'メモ'));
   assert(dup.tasks.every((t) => t.laneId === dup.lane.id && !worked.some((w) => w.id === t.id)));
   equal(titles(dup.tasks), titles(worked.filter((t) => t.laneId === source.id)));
   const sections = apply([...lanes, dup.lane], dup.lanes).filter((l) => l.type === 'section');
   equal(titles(sections).slice(3, 5), ['サビ', 'サビ4'], '元のレーンの直後');
});

test('moveLane: 同じ種類の中だけで並べ替える', () => {
   const { lanes } = createProject({ title: 'x' }, structure('inst'), library);
   const sections = sortByOrder(lanes.filter((l) => l.type === 'section'));
   const moved = apply(lanes, moveLane(lanes, sections[0].id, 3));
   equal(titles(moved.filter((l) => l.type === 'section')), ['汎用2', '汎用3', '汎用4', '汎用']);
   equal(moved.find((l) => l.type === 'global').order, lanes.find((l) => l.type === 'global').order);
});

test('sectionColors: 並び順にパレットの色を割り振る。同じ種別は同じ色', () => {
   const { lanes } = createProject({ title: 'x' }, structure('vocal'), library);
   const colorOf = (all, name) => sectionColors(all).get(all.find((l) => l.name === name).id);
   const [c1, c2, c3, c4] = SECTION_COLORS;
   equal(['イントロ', 'Aメロ', 'Bメロ', 'サビ'].map((n) => colorOf(lanes, n)), [c1, c2, c3, c4]);
   equal(['Aメロ2', 'サビ2', 'サビ3'].map((n) => colorOf(lanes, n)), [c2, c4, c4], '同じ種別は同じ色');
   equal(colorOf(lanes, 'アウトロ'), SECTION_COLORS[6]);
   assert(!sectionColors(lanes).has(lanes.find((l) => l.type === 'global').id), '「全体」レーンには割り振らない');

   // 並べ替えると、位置に合わせて色が入れ替わる
   const sections = sortByOrder(lanes.filter((l) => l.type === 'section'));
   const moved = apply(lanes, moveLane(lanes, sections[2].id, 1));
   equal(['イントロ', 'Bメロ', 'Aメロ', 'サビ'].map((n) => colorOf(moved, n)), [c1, c2, c3, c4]);
   equal(colorOf(moved, 'Aメロ2'), c3);
   // 名前を変えても種別が同じなら同じ色
   const renamed = apply(lanes, [renameLane(lanes.find((l) => l.name === 'サビ3'), '落ちサビ')]);
   equal(colorOf(renamed, '落ちサビ'), c4);
});

test('sectionColors: 種別のないセクションは名前で見分ける / 色を使い切ったら先頭に戻る', () => {
   const { project, lanes } = createProject({ title: 'x' }, null, library);
   const base = { projectId: project.id, templateTasks: [], kind: null };
   const a = addSection({ ...base, lanes, name: 'ブレイク' }).lane;
   const b = addSection({ ...base, lanes: [...lanes, a], name: 'ドロップ' }).lane;
   const all = [...lanes, a, b];
   const dup = duplicateLane(a.id, all, []);
   const colors = sectionColors(apply([...all, dup.lane], dup.lanes));
   equal(dup.lane.name, 'ブレイク2');
   equal([colors.get(a.id), colors.get(dup.lane.id), colors.get(b.id)], [SECTION_COLORS[0], SECTION_COLORS[0], SECTION_COLORS[1]]);

   const many = colorsInOrder(Array.from({ length: SECTION_COLORS.length + 2 }, (_, i) => `k${i}`));
   equal(many.slice(-2), SECTION_COLORS.slice(0, 2));
   equal(new Set(SECTION_COLORS).size, 18, 'パレットは重複のない18色');
});

test('renameLane: 空の名前は拒否', () => {
   const { lanes } = createProject({ title: 'x' }, structure('inst'), library);
   const section = lanes.find((l) => l.type === 'section');
   equal(renameLane(section, ' ドロップ ').name, 'ドロップ');
   throws(() => renameLane(section, ''));
});

// ---- task ----

function fixture() {
   const { project, lanes, tasks } = createProject({ title: 'x' }, structure('vocal'), library);
   const lane = (name) => lanes.find((l) => l.name === name);
   const inLane = (all, name) => sortByOrder(all.filter((t) => t.laneId === lane(name).id));
   return { project, lanes, tasks, lane, inLane };
}

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

test('promoteTask: セクションのタスクは、その種別の定番になる', () => {
   const { tasks, lane, inLane } = fixture();
   const custom = addTask(lane('サビ2'), inLane(tasks, 'サビ2'), 'ハモリ');
   const templateTask = promoteTask({ ...custom, memo: 'm' }, lane('サビ2'), library.templateTasks);
   equal([templateTask.scope, templateTask.kindId, templateTask.title, templateTask.memo],
      ['kind', 'seed-kind-chorus', 'ハモリ', 'm']);
   // 以後に作るプロジェクトでは、定番の末尾に入る
   const next = createProject({ title: 'y' }, structure('vocal'),
      { ...library, templateTasks: [...library.templateTasks, templateTask] });
   const chorus = next.lanes.find((l) => l.name === 'サビ');
   equal(titles(next.tasks.filter((t) => t.laneId === chorus.id)).at(-1), 'ハモリ');
});

test('promoteTask: 「全体」レーンのタスクは「全体」の定番になる / 追加できない場合', () => {
   const { project, lanes, tasks, lane, inLane } = fixture();
   const global = lanes.find((l) => l.type === 'global');
   const templateTask = promoteTask(addTask(global, [], 'リファレンス曲を決める'), global, library.templateTasks);
   equal([templateTask.scope, templateTask.kindId, templateTask.order], ['global', null, 7]);

   const { lane: noKind } = addSection({ projectId: project.id, lanes, kind: null, templateTasks: [], name: 'ブレイク' });
   throws(() => promoteTask(addTask(noKind, [], 'x'), noKind, library.templateTasks), '種別のないセクション');
   throws(() => promoteTask(inLane(tasks, 'サビ')[0], lane('サビ'), library.templateTasks), '同じタイトルの定番がある');
   // タイトルを変えたタスクは、別の定番として追加できる
   const edited = updateTask(inLane(tasks, 'サビ')[0], { title: 'コード確定(転調)' });
   equal(promoteTask(edited, lane('サビ'), library.templateTasks).title, 'コード確定(転調)');
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

// ---- library ----

test('newKind / updateKind: 末尾に追加。色は持たない', () => {
   const k = newKind(library.kinds.slice(0, 3), { name: ' ブレイク ' });
   equal([k.name, k.order], ['ブレイク', 4]);
   assert(!('color' in k) && library.kinds.every((x) => !('color' in x)), '色はセクションの並びで決まる');
   throws(() => newKind([], { name: ' ' }));
   equal(updateKind(k, { name: 'ドロップ' }).name, 'ドロップ');
   throws(() => updateKind(k, { name: '' }));
});

test('newTemplateTask: 系統ごとの末尾に追加', () => {
   const a = newTemplateTask(library.templateTasks, { kindId: 'seed-kind-chorus', title: ' ハモリ ' });
   equal([a.scope, a.kindId, a.title, a.order, a.memo], ['kind', 'seed-kind-chorus', 'ハモリ', 7, '']);
   const g = newTemplateTask(library.templateTasks, { kindId: null, title: 'リファレンス' });
   equal([g.scope, g.kindId, g.order], ['global', null, 7]);
   equal(newTemplateTask(library.templateTasks, { kindId: 'seed-kind-intro', title: 'x' }).order, 1);
   throws(() => newTemplateTask([], { kindId: null, title: '' }));
});

test('updateTemplateTask / moveTemplateTask: 編集と、同じ系統の中での並べ替え', () => {
   const chorus = templatesFor(library.templateTasks, 'seed-kind-chorus');
   const edited = updateTemplateTask(chorus[0], { title: 'コード', memo: 'm' });
   equal([edited.title, edited.memo], ['コード', 'm']);
   throws(() => updateTemplateTask(chorus[0], { title: ' ' }));

   const changed = moveTemplateTask(library.templateTasks, chorus[5].id, 0);
   equal(changed.length, 1);
   const after = library.templateTasks.map((t) => changed.find((c) => c.id === t.id) ?? t);
   equal(titles(templatesFor(after, 'seed-kind-chorus')), ['コーラス', 'コード確定', 'メロ確定', 'ドラム', 'ベース', '上モノ']);
   equal(titles(templatesFor(after, 'seed-kind-verse')), ['コード確定', 'メロ確定', 'ドラム', 'ベース'], '他の種別は変わらない');
   // この順番が、以後に作るセクションの初期の並びになる
   const { lanes, tasks } = createProject({ title: 'x' }, structure('vocal'), { ...library, templateTasks: after });
   equal(titles(tasks.filter((t) => t.laneId === lanes.find((l) => l.name === 'サビ').id))[0], 'コーラス');
});

test('removeKind: 定番タスクと構成テンプレートの参照を片付ける', () => {
   const result = removeKind('seed-kind-chorus', library);
   equal(result.templateTaskIds.length, 6);
   equal(result.structures.map((s) => s.id), ['seed-structure-vocal']);
   equal(result.structures[0].sections.length, 8);
   assert(!result.structures[0].sections.includes('seed-kind-chorus'));
   equal(structure('vocal').sections.length, 11, '元のレコードは変更しない');
});

test('newStructure / updateStructure', () => {
   const s = newStructure(library.structures, { name: ' EDM ' });
   equal([s.name, s.sections, s.order], ['EDM', [], 3]);
   assert(!('globalLanes' in s), '「全体」レーンは構成テンプレートに持たせない');
   const edited = updateStructure(s, { sections: ['seed-kind-intro', 'seed-kind-generic', 'seed-kind-generic'] });
   equal(edited.sections.length, 3);
   throws(() => updateStructure(s, { name: '' }));
   const { lanes } = createProject({ title: 'x' }, edited, library);
   equal(titles(lanes.filter((l) => l.type === 'global')), ['全体']);
   equal(titles(lanes.filter((l) => l.type === 'section')), ['イントロ', '汎用', '汎用2']);
});

// ---- store(DOM非依存の部分) ----

test('migrate: 検証して形を揃える', () => {
   const data = migrate(JSON.stringify({ schemaVersion: 1, projects: [{ id: 'p' }] }));
   equal([data.schemaVersion, data.projects.length, data.tasks.length], [SCHEMA_VERSION, 1, 0]);
   throws(() => migrate('not json'));
   throws(() => migrate({ projects: [] }), 'schemaVersion なし');
   throws(() => migrate({ schemaVersion: SCHEMA_VERSION + 1 }), '新しすぎる');
   throws(() => migrate({ schemaVersion: 1, tasks: [{}] }), 'id なし');
});

test('migrate: 廃止した項目(タスクの出自、種別の色)を落とす', () => {
   const data = migrate({
      schemaVersion: 1,
      tasks: [{ id: 't', title: 'x', origin: 'standard', sourceTemplateTaskId: 's' }],
      kinds: [{ id: 'k', name: 'サビ', color: '#ef4444' }],
   });
   equal([data.tasks, data.kinds], [[{ id: 't', title: 'x' }], [{ id: 'k', name: 'サビ' }]]);
});

// ---- store: Supabase 実装 ----

// Supabase の REST API(PostgREST)のふりをする fetch。テーブルをメモリに持ち、
// supabase.js が使う機能(eq / not.is.null の絞り込み、limit と offset、upsert、delete)だけに応える。
// 外部キーの cascade など、データベース側の動きは再現しない。
function fakeSupabase({ key = 'KEY', failWith = null } = {}) {
   const tables = {};
   const respond = (status, body) => ({ ok: status < 400, status, json: async () => body });
   const fetchImpl = async (input, { method, headers, body }) => {
      const url = new URL(input);
      const table = url.pathname.split('/').pop();
      if (headers.apikey !== key || headers.Authorization !== `Bearer ${key}`) {
         return respond(401, { message: 'Invalid API key' });
      }
      if (failWith) return respond(failWith.status, failWith.body);

      const pk = table === 'app_meta' ? 'key' : 'id';
      const rows = (tables[table] ??= []);
      const options = ['select', 'order', 'limit', 'offset'];
      const matches = (row) => [...url.searchParams].every(([column, condition]) => options.includes(column)
         || (condition === 'not.is.null' ? row[column] != null : String(row[column]) === condition.replace(/^eq\./, '')));

      if (method === 'GET') {
         const offset = Number(url.searchParams.get('offset') ?? 0);
         const limit = Number(url.searchParams.get('limit') ?? 1000);
         const found = rows.filter(matches).sort((a, b) => (a[pk] < b[pk] ? -1 : 1));
         return respond(200, found.slice(offset, offset + limit));
      }
      if (method === 'POST') {
         for (const row of JSON.parse(body)) {
            const i = rows.findIndex((r) => r[pk] === row[pk]);
            if (i >= 0) rows[i] = { ...rows[i], ...row };
            else rows.push(row);
         }
         return respond(201, null);
      }
      if (method === 'DELETE') {
         tables[table] = rows.filter((row) => !matches(row));
         return respond(204, null);
      }
      return respond(405, { message: method });
   };
   return { tables, repository: createSupabaseRepository({ url: 'https://example.supabase.co', key: 'KEY' }, fetchImpl) };
}

test('supabase: 列名の対応(camelCase ↔ snake_case、order ↔ sort_order)と日時の形', () => {
   const { tasks } = createProject({ title: 'x', dueDate: '2026-10-31' }, structure('vocal'), library);
   const row = toRow(tasks[0]);
   equal(Object.keys(row).sort(), ['created_at', 'done_at', 'id', 'lane_id', 'memo', 'project_id',
      'sort_order', 'status', 'title', 'updated_at']);
   equal(fromRow(row), tasks[0], '往復しても変わらない');
   // データベースは日時を +00:00 の形で返す。IndexedDB 実装と同じ …Z に揃える
   const back = fromRow({ created_at: '2026-10-12T04:25:44.487+00:00', done_at: null, due_date: '2026-10-31' });
   equal(back, { createdAt: '2026-10-12T04:25:44.487Z', doneAt: null, dueDate: '2026-10-31' });
});

test('supabase: 保存して読み戻せる。初期データの投入は1回だけ', async () => {
   const { tables, repository } = fakeSupabase();
   equal(await ensureSeeded(repository), true);
   equal(await ensureSeeded(repository), false, '2回目は入れない');
   const lib = await repository.getLibrary();
   equal([lib.kinds.length, lib.templateTasks.length, lib.structures.length], [8, 16, 2]);
   equal(titles(lib.kinds), titles(library.kinds));
   assert('sort_order' in tables.section_kinds[0] && !('order' in tables.section_kinds[0]), '列名は sort_order');

   const { project, lanes, tasks } = createProject({ title: '曲A', dueDate: '2026-10-31' }, lib.structures.find((s) => s.name === '歌モノ'), lib);
   const other = createProject({ title: '曲B' }, null, lib);
   for (const p of [{ project, lanes, tasks }, other]) {
      await repository.saveProject(p.project);
      await repository.saveLanes(p.lanes);
      await repository.saveTasks(p.tasks);
   }
   equal(await repository.getProject(project.id), project);
   equal(await repository.getProject('missing'), null);
   equal((await repository.getProjects()).length, 2);
   equal(ids(await repository.getLanes(project.id)), ids(lanes), 'プロジェクトで絞る');
   equal((await repository.getTasks(project.id)).length, tasks.length);
   equal((await repository.getTasks(other.project.id)).length, 6);

   await repository.saveTask({ ...tasks[0], title: '変更' });
   const saved = (await repository.getTasks(project.id)).find((t) => t.id === tasks[0].id);
   equal([saved.title, tables.tasks.filter((r) => r.project_id === project.id).length], ['変更', tasks.length], '同じIDは上書き');
   await repository.deleteTask(tasks[0].id);
   equal((await repository.getTasks(project.id)).length, tasks.length - 1);
});

test('supabase: 1回の上限(1000行)を超えても全部読める', async () => {
   const { repository } = fakeSupabase();
   const { project, lanes } = createProject({ title: 'x' }, null, { kinds: [], templateTasks: [] });
   const many = Array.from({ length: 2500 }, (_, i) => ({ ...addTask(lanes[0], [], `t${i}`), order: i }));
   await repository.saveProject(project);
   await repository.saveLanes(lanes);
   await repository.saveTasks(many);
   const read = await repository.getTasks(project.id);
   equal([read.length, new Set(read.map((t) => t.id)).size], [2500, 2500]);
});

test('supabase: エクスポートとインポート(全部置き換える)', async () => {
   const a = fakeSupabase().repository;
   await ensureSeeded(a);
   const lib = await a.getLibrary();
   const { project, lanes, tasks } = createProject({ title: '曲A' }, lib.structures[0], lib);
   await a.saveProject(project);
   await a.saveLanes(lanes);
   await a.saveTasks(tasks);
   const exported = await a.exportAll();
   equal([exported.schemaVersion, exported.projects.length, exported.tasks.length], [SCHEMA_VERSION, 1, tasks.length]);

   const b = fakeSupabase().repository;
   const old = createProject({ title: '消える' }, null, { kinds: [], templateTasks: [] });
   await b.saveProject(old.project);
   await b.saveLanes(old.lanes);
   await b.importAll(JSON.stringify(exported));
   equal((await b.getProjects()).map((p) => p.title), ['曲A']);
   equal((await b.getLanes(old.project.id)).length, 0);
   equal((await b.getTasks(project.id)).length, tasks.length);
   equal((await b.getLibrary()).kinds.length, 8);
   equal(await ensureSeeded(b), false, 'インポート後に初期データを重ねない');
   await rejects(b.importAll('{"x":1}'), 'エクスポートデータではありません');
});

test('supabase: つながらない理由を伝える', async () => {
   const config = { url: 'https://example.supabase.co', key: 'KEY' };
   const using = (options) => {
      const { repository } = fakeSupabase(options);
      return repository.getProjects();
   };
   await rejects(using({ key: 'OTHER' }), '公開キーが正しくありません');
   await rejects(using({ failWith: { status: 401, body: { code: '42501', message: 'permission denied' } } }), '権限がありません');
   await rejects(using({ failWith: { status: 404, body: { code: 'PGRST205', message: 'not found' } } }), 'テーブルが見つかりません');
   await rejects(using({ failWith: { status: 500, body: { message: 'boom' } } }), 'boom');
   await rejects(checkConnection(config, async () => { throw new TypeError('Failed to fetch'); }), '接続できません');
   await checkConnection(config, async () => ({ ok: true, status: 200, json: async () => [] }));
});

test('normalizeProjectUrl: 余分なパスや空白を落とす', () => {
   equal(normalizeProjectUrl('  https://abc.supabase.co/rest/v1/ '), 'https://abc.supabase.co');
   equal(normalizeProjectUrl('http://localhost:54321'), 'http://localhost:54321');
   throws(() => normalizeProjectUrl('abc.supabase.co'), 'スキームなし');
   throws(() => normalizeProjectUrl('http://abc.supabase.co'), 'http');
});

export async function run() {
   const results = [];
   for (const { name, fn } of tests) {
      try {
         await fn();
         results.push({ name, ok: true });
      } catch (error) {
         results.push({ name, ok: false, error: error.message });
      }
   }
   return results;
}

/** コンソール向けの出力。失敗があれば false を返す。 */
export async function report() {
   const results = await run();
   for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : `\n     ${r.error}`}`);
   const failed = results.filter((r) => !r.ok).length;
   console.log(`\n${results.length - failed}/${results.length} passed`);
   return failed === 0;
}
