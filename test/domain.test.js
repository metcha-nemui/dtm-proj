// ドメインロジックと保存まわりの簡易テスト。test.html をブラウザで開くと実行される。
// Node でも動く: node -e "import('./test/domain.test.js').then(m => m.report()).then(ok => process.exit(ok ? 0 : 1))"

import {
   duplicateTemplate, moveKind, moveTemplateTask, newKind, newTemplate, newTemplateTask, removeKind, templateFromProject,
   updateKind, updateTemplate, updateTemplateTask,
} from '../js/domain/library.js';
import { orderAtEnd, orderBetween, placeAt, reorder, sortByOrder } from '../js/domain/order.js';
import {
   addSection, assertSection, colorsInOrder, createProject, daysUntilDue, duplicateLane, moveLane, normalizeDueDate, renameLane,
   SECTION_COLORS, sectionColors, templatesFor, uniqueLaneName, updateProject,
} from '../js/domain/project.js';
import { summarize, summarizeByLane } from '../js/domain/stats.js';
import {
   addTask, cycleStatus, moveTask, promoteTarget, promoteTask, setStatus, updateTask,
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
const template = (key) => library.templates.find((t) => t.id === `seed-template-${key}`);
const kind = (key, templateKey = 'vocal') => library.kinds.find((k) => k.id === `seed-kind-${templateKey}-${key}`);
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
   const { project, lanes, tasks } = createProject({ title: ' 新曲 ' }, template('vocal'), library);
   equal([project.title, project.templateId], ['新曲', 'seed-template-vocal']);
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

test('createProject: 「全体」レーンはテンプレートに関係なく必ず1本でき、そのテンプレートの定番が入る', () => {
   for (const [t, count] of [[template('vocal'), 6], [template('inst'), 5], [null, 0]]) {
      const { lanes, tasks } = createProject({ title: 'x' }, t, library);
      const globals = lanes.filter((l) => l.type === 'global');
      equal(globals.map((l) => [l.name, l.kindId]), [['全体', null]]);
      equal(tasks.filter((t2) => t2.laneId === globals[0].id).length, count);
   }
   const inst = createProject({ title: 'x' }, template('inst'), library);
   assert(!titles(inst.tasks).includes('歌詞'), 'インストの「全体」に歌詞はない');
   equal(titles(inst.lanes.filter((l) => l.type === 'section')), ['汎用', '汎用2', '汎用3', '汎用4']);
   const none = createProject({ title: '' }, null, library);
   equal([none.project.title, none.project.templateId], ['無題のプロジェクト', null]);
   equal([none.lanes.length, none.tasks.length], [1, 0]);
});

test('「全体」レーンは名前変更・複製・削除できない', () => {
   const { lanes, tasks } = createProject({ title: 'x' }, template('inst'), library);
   const global = lanes.find((l) => l.type === 'global');
   throws(() => renameLane(global, 'ミックス'), '名前変更');
   throws(() => duplicateLane(global.id, lanes, tasks), '複製');
   throws(() => assertSection(global, '削除'), '削除');
   assertSection(lanes.find((l) => l.type === 'section'), '削除');
});

test('createProject: コピー方式なのでライブラリを変えても影響しない', () => {
   const lib = buildSeed();
   const { tasks } = createProject({ title: 'x' }, lib.templates[0], lib);
   lib.templateTasks[0].title = '変更後';
   assert(tasks.every((t) => t.title !== '変更後'));
});

test('createProject: 削除済みの種別と、他のテンプレートの種別は飛ばす', () => {
   const s = { ...template('vocal'), sections: ['seed-kind-vocal-chorus', 'gone', 'seed-kind-inst-generic', 'seed-kind-vocal-verse'] };
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
   const { project, lanes } = createProject({ title: 'x' }, template('vocal'), library);
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
   const { project, lanes } = createProject({ title: 'x' }, template('inst'), library);
   const base = { projectId: project.id, lanes, templateTasks: library.templateTasks };
   const empty = addSection({ ...base, kind: kind('chorus'), empty: true });
   equal(empty.tasks.length, 0);
   equal(titles([...lanes, empty.lane].filter((l) => l.type === 'section')).at(-1), 'サビ');
   const noKind = addSection({ ...base, kind: null, name: ' ブレイク ' });
   equal([noKind.lane.name, noKind.lane.kindId, noKind.tasks.length], ['ブレイク', null, 0]);
});

test('duplicateLane: タスクごと複製し、ステータスは未着手に戻す', () => {
   const { lanes, tasks } = createProject({ title: 'x' }, template('vocal'), library);
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
   const { lanes } = createProject({ title: 'x' }, template('inst'), library);
   const sections = sortByOrder(lanes.filter((l) => l.type === 'section'));
   const moved = apply(lanes, moveLane(lanes, sections[0].id, 3));
   equal(titles(moved.filter((l) => l.type === 'section')), ['汎用2', '汎用3', '汎用4', '汎用']);
   equal(moved.find((l) => l.type === 'global').order, lanes.find((l) => l.type === 'global').order);
});

test('sectionColors: 並び順にパレットの色を割り振る。同じ種別は同じ色', () => {
   const { lanes } = createProject({ title: 'x' }, template('vocal'), library);
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
   const { lanes } = createProject({ title: 'x' }, template('inst'), library);
   const section = lanes.find((l) => l.type === 'section');
   equal(renameLane(section, ' ドロップ ').name, 'ドロップ');
   throws(() => renameLane(section, ''));
});

// ---- task ----

function fixture() {
   const { project, lanes, tasks } = createProject({ title: 'x' }, template('vocal'), library);
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
   const { project } = fixture();
   const templateTask = promoteTask({ ...custom, memo: 'm' }, lane('サビ2'), project, library);
   equal([templateTask.templateId, templateTask.scope, templateTask.kindId, templateTask.title, templateTask.memo],
      ['seed-template-vocal', 'kind', 'seed-kind-vocal-chorus', 'ハモリ', 'm']);
   equal(promoteTarget(lane('サビ2'), project, library).kind.name, 'サビ');
   // 以後に作るプロジェクトでは、定番の末尾に入る
   const next = createProject({ title: 'y' }, template('vocal'),
      { ...library, templateTasks: [...library.templateTasks, templateTask] });
   const chorus = next.lanes.find((l) => l.name === 'サビ');
   equal(titles(next.tasks.filter((t) => t.laneId === chorus.id)).at(-1), 'ハモリ');
});

test('promoteTask: 「全体」レーンのタスクは「全体」の定番になる / 追加できない場合', () => {
   const { project, lanes, tasks, lane, inLane } = fixture();
   const global = lanes.find((l) => l.type === 'global');
   const templateTask = promoteTask(addTask(global, [], 'リファレンス曲を決める'), global, project, library);
   equal([templateTask.templateId, templateTask.scope, templateTask.kindId, templateTask.order],
      ['seed-template-vocal', 'global', null, 7]);
   // 行き先は、そのプロジェクトのテンプレート。インストの「全体」の定番は5件
   const inst = createProject({ title: 'i' }, template('inst'), library);
   const instGlobal = inst.lanes.find((l) => l.type === 'global');
   const instTask = promoteTask(addTask(instGlobal, [], '歌詞'), instGlobal, inst.project, library);
   equal([instTask.templateId, instTask.order], ['seed-template-inst', 6], '歌モノに「歌詞」があっても、インストには追加できる');

   const { lane: noKind } = addSection({ projectId: project.id, lanes, kind: null, templateTasks: [], name: 'ブレイク' });
   throws(() => promoteTask(addTask(noKind, [], 'x'), noKind, project, library), '種別のないセクション');
   throws(() => promoteTask(inLane(tasks, 'サビ')[0], lane('サビ'), project, library), '同じタイトルの定番がある');
   // タイトルを変えたタスクは、別の定番として追加できる
   const edited = updateTask(inLane(tasks, 'サビ')[0], { title: 'コード確定(転調)' });
   equal(promoteTask(edited, lane('サビ'), project, library).title, 'コード確定(転調)');

   // テンプレートがない(または削除された)プロジェクトでは、行き先がない
   const none = createProject({ title: 'n' }, null, library);
   throws(() => promoteTask(addTask(none.lanes[0], [], 'x'), none.lanes[0], none.project, library), 'テンプレートなし');
   const orphan = { ...library, templates: [], kinds: [] };
   equal([promoteTarget(global, project, orphan), promoteTarget(lane('サビ'), project, orphan)], [null, null]);
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

test('newKind / updateKind / moveKind: テンプレートの中の末尾に追加。色は持たない', () => {
   const k = newKind(library.kinds, { templateId: 'seed-template-vocal', name: ' ブレイク ' });
   equal([k.templateId, k.name, k.order], ['seed-template-vocal', 'ブレイク', 8]);
   equal(newKind(library.kinds, { templateId: 'seed-template-inst', name: 'ドロップ' }).order, 2, '他のテンプレートの種別は数えない');
   assert(!('color' in k) && library.kinds.every((x) => !('color' in x)), '色はセクションの並びで決まる');
   throws(() => newKind([], { templateId: 't', name: ' ' }));
   equal(updateKind(k, { name: 'ドロップ' }).name, 'ドロップ');
   throws(() => updateKind(k, { name: '' }));

   const moved = apply(library.kinds, moveKind(library.kinds, 'seed-kind-vocal-chorus', 0));
   equal(titles(moved.filter((x) => x.templateId === 'seed-template-vocal')).slice(0, 3), ['サビ', 'イントロ', 'Aメロ']);
   equal(moved.find((x) => x.id === 'seed-kind-inst-generic'), kind('generic', 'inst'), '他のテンプレートは変わらない');
});

test('newTemplateTask: 系統ごとの末尾に追加', () => {
   const vocal = { templateId: 'seed-template-vocal' };
   const a = newTemplateTask(library.templateTasks, { ...vocal, kindId: 'seed-kind-vocal-chorus', title: ' ハモリ ' });
   equal([a.templateId, a.scope, a.kindId, a.title, a.order, a.memo],
      ['seed-template-vocal', 'kind', 'seed-kind-vocal-chorus', 'ハモリ', 7, '']);
   const g = newTemplateTask(library.templateTasks, { ...vocal, kindId: null, title: 'リファレンス' });
   equal([g.scope, g.kindId, g.order], ['global', null, 7]);
   const i = newTemplateTask(library.templateTasks, { templateId: 'seed-template-inst', kindId: null, title: 'リファレンス' });
   equal([i.templateId, i.order], ['seed-template-inst', 6], '「全体」の定番もテンプレートごと');
   equal(newTemplateTask(library.templateTasks, { ...vocal, kindId: 'seed-kind-vocal-intro', title: 'x' }).order, 1);
   throws(() => newTemplateTask([], { ...vocal, kindId: null, title: '' }));
});

test('updateTemplateTask / moveTemplateTask: 編集と、同じ系統の中での並べ替え', () => {
   const forKind = (all, key) => templatesFor(all, 'seed-template-vocal', `seed-kind-vocal-${key}`);
   const chorus = forKind(library.templateTasks, 'chorus');
   const edited = updateTemplateTask(chorus[0], { title: 'コード', memo: 'm' });
   equal([edited.title, edited.memo], ['コード', 'm']);
   throws(() => updateTemplateTask(chorus[0], { title: ' ' }));

   const changed = moveTemplateTask(library.templateTasks, chorus[5].id, 0);
   equal(changed.length, 1);
   const after = library.templateTasks.map((t) => changed.find((c) => c.id === t.id) ?? t);
   equal(titles(forKind(after, 'chorus')), ['コーラス', 'コード確定', 'メロ確定', 'ドラム', 'ベース', '上モノ']);
   equal(titles(forKind(after, 'verse')), ['コード確定', 'メロ確定', 'ドラム', 'ベース'], '他の種別は変わらない');
   // この順番が、以後に作るセクションの初期の並びになる
   const { lanes, tasks } = createProject({ title: 'x' }, template('vocal'), { ...library, templateTasks: after });
   equal(titles(tasks.filter((t) => t.laneId === lanes.find((l) => l.name === 'サビ').id))[0], 'コーラス');
});

test('removeKind: 定番タスクと、テンプレートの並びからの参照を片付ける', () => {
   const result = removeKind('seed-kind-vocal-chorus', library);
   equal(result.templateTaskIds.length, 6);
   equal(result.templates.map((s) => s.id), ['seed-template-vocal']);
   equal(result.templates[0].sections.length, 8);
   assert(!result.templates[0].sections.includes('seed-kind-vocal-chorus'));
   equal(template('vocal').sections.length, 11, '元のレコードは変更しない');
});

test('newTemplate / updateTemplate', () => {
   const s = newTemplate(library.templates, { name: ' EDM ' });
   equal([s.name, s.sections, s.order], ['EDM', [], 3]);
   throws(() => newTemplate([], { name: ' ' }));
   throws(() => updateTemplate(s, { name: '' }));
   const edited = updateTemplate(template('vocal'),
      { sections: ['seed-kind-vocal-intro', 'seed-kind-vocal-chorus', 'seed-kind-vocal-chorus'] });
   equal(template('vocal').sections.length, 11, '元のレコードは変更しない');
   const { lanes } = createProject({ title: 'x' }, edited, library);
   equal(titles(lanes.filter((l) => l.type === 'global')), ['全体']);
   equal(titles(lanes.filter((l) => l.type === 'section')), ['イントロ', 'サビ', 'サビ2']);
});

test('duplicateTemplate: 種別と定番タスクごと複製し、元とは切り離す', () => {
   const before = JSON.stringify(library);
   const copy = duplicateTemplate(template('vocal'), library);
   equal(JSON.stringify(library), before, '元のライブラリは変更しない');
   equal([copy.template.name, copy.template.order], ['歌モノのコピー', 3]);
   equal([copy.kinds.length, copy.templateTasks.length], [7, 16]);
   const originalIds = new Set([...library.kinds, ...library.templateTasks, ...library.templates].map((r) => r.id));
   assert([copy.template, ...copy.kinds, ...copy.templateTasks].every((r) => !originalIds.has(r.id)), 'IDは新しい');
   assert(copy.kinds.every((k) => k.templateId === copy.template.id));
   assert(copy.templateTasks.every((t) => t.templateId === copy.template.id));
   assert(copy.templateTasks.every((t) => t.kindId === null || copy.kinds.some((k) => k.id === t.kindId)), '定番は複製した種別を指す');

   // 複製から作ったプロジェクトは、元と同じ構成になる
   const merged = {
      templates: [...library.templates, copy.template],
      kinds: [...library.kinds, ...copy.kinds],
      templateTasks: [...library.templateTasks, ...copy.templateTasks],
   };
   const a = createProject({ title: 'a' }, template('vocal'), merged);
   const b = createProject({ title: 'b' }, copy.template, merged);
   const sectionNames = (p) => titles(p.lanes.filter((l) => l.type === 'section'));
   equal(sectionNames(b), sectionNames(a));
   equal(b.tasks.map((t) => t.title).sort(), a.tasks.map((t) => t.title).sort());
   equal(b.project.templateId, copy.template.id);
});

test('templateFromProject: プロジェクトの構成からテンプレートを作る', () => {
   const { project, lanes, tasks, lane, inLane } = fixture();
   // サビにタスクを足し、サビ2は空にして、種別なしのセクションを2本足す
   const extra = addTask(lane('サビ'), inLane(tasks, 'サビ'), 'ハモリ');
   const a = addSection({ projectId: project.id, lanes, kind: null, templateTasks: [], name: 'ドロップ', index: 1 }).lane;
   const b = duplicateLane(a.id, [...lanes, a], []);
   const allLanes = apply([...lanes, a, b.lane], b.lanes);
   const drop = addTask(a, [], 'ベースを抜く');
   const allTasks = [...tasks.filter((t) => t.laneId !== lane('サビ2').id), extra, { ...drop, memo: 'm' }];

   const made = templateFromProject({ name: ' 新しい型 ' }, { lanes: allLanes, tasks: allTasks }, library);
   equal([made.template.name, made.template.order], ['新しい型', 3]);
   equal(titles(made.kinds), ['イントロ', 'ドロップ', 'Aメロ', 'Bメロ', 'サビ', '間奏', 'Cメロ', 'アウトロ'], '同じ種別は1つにまとめる');
   const nameOf = new Map(made.kinds.map((k) => [k.id, k.name]));
   equal(made.template.sections.map((id) => nameOf.get(id)),
      ['イントロ', 'ドロップ', 'ドロップ', 'Aメロ', 'Bメロ', 'サビ', '間奏', 'Aメロ', 'Bメロ', 'サビ', 'Cメロ', 'サビ', 'アウトロ']);
   assert(made.kinds.every((k) => k.templateId === made.template.id && !library.kinds.some((x) => x.id === k.id)));

   const tasksOf = (name) => templatesFor(made.templateTasks, made.template.id, made.kinds.find((k) => k.name === name).id);
   equal(titles(tasksOf('サビ')), ['コード確定', 'メロ確定', 'ドラム', 'ベース', '上モノ', 'コーラス', 'ハモリ'], '最初のセクションのタスク');
   equal(tasksOf('ドロップ').map((t) => [t.title, t.memo]), [['ベースを抜く', 'm']]);
   equal(titles(templatesFor(made.templateTasks, made.template.id, null)),
      ['テンポ・キー決定', '仮タイトル', '歌詞', 'ミックス', 'マスタリング', '書き出し']);
   throws(() => templateFromProject({ name: '' }, { lanes, tasks }, library));

   // できたテンプレートから作ると、同じ並びになる
   const next = createProject({ title: 'y' }, made.template, { kinds: made.kinds, templateTasks: made.templateTasks });
   equal(titles(next.lanes.filter((l) => l.type === 'section')),
      ['イントロ', 'ドロップ', 'ドロップ2', 'Aメロ', 'Bメロ', 'サビ', '間奏', 'Aメロ2', 'Bメロ2', 'サビ2', 'Cメロ', 'サビ3', 'アウトロ']);
});

// ---- store(DOM非依存の部分) ----

test('migrate: 検証して形を揃える', () => {
   const data = migrate(JSON.stringify({ schemaVersion: SCHEMA_VERSION, projects: [{ id: 'p' }] }));
   equal([data.schemaVersion, data.projects.length, data.tasks.length, data.templates.length], [SCHEMA_VERSION, 1, 0, 0]);
   throws(() => migrate('not json'));
   throws(() => migrate({ projects: [] }), 'schemaVersion なし');
   throws(() => migrate({ schemaVersion: SCHEMA_VERSION + 1 }), '新しすぎる');
   throws(() => migrate({ schemaVersion: SCHEMA_VERSION, tasks: [{}] }), 'id なし');
});

test('migrate: テンプレートに一本化する前のデータは読み込まない', () => {
   for (const schemaVersion of [1, 2]) {
      let message = '';
      try {
         migrate({ schemaVersion, projects: [], structures: [] });
      } catch (error) {
         message = error.message;
      }
      assert(message.includes('古い形式'), `schemaVersion ${schemaVersion}: ${message}`);
   }
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
   const { tasks } = createProject({ title: 'x', dueDate: '2026-10-31' }, template('vocal'), library);
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
   equal([lib.templates.length, lib.kinds.length, lib.templateTasks.length], [2, 8, 21]);
   equal(titles(lib.kinds), titles(library.kinds));
   assert('sort_order' in tables.section_kinds[0] && !('order' in tables.section_kinds[0]), '列名は sort_order');
   assert(tables.section_kinds.every((r) => r.template_id) && tables.template_tasks.every((r) => r.template_id), '列名は template_id');
   equal(Object.keys(tables).sort(), ['app_meta', 'section_kinds', 'template_tasks', 'templates']);

   const { project, lanes, tasks } = createProject({ title: '曲A', dueDate: '2026-10-31' }, lib.templates.find((t) => t.name === '歌モノ'), lib);
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
   equal((await repository.getTasks(other.project.id)).length, 0);

   await repository.saveTask({ ...tasks[0], title: '変更' });
   const saved = (await repository.getTasks(project.id)).find((t) => t.id === tasks[0].id);
   equal([saved.title, tables.tasks.filter((r) => r.project_id === project.id).length], ['変更', tasks.length], '同じIDは上書き');
   equal(tables.projects.find((r) => r.id === project.id).template_id, 'seed-template-vocal');
   // 種別と定番タスクは、データベース側の cascade で消える(このテストの fetch は再現しない)
   await repository.deleteTemplate('seed-template-inst');
   equal((await repository.getLibrary()).templates.map((t) => t.id), ['seed-template-vocal']);
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
   const { project, lanes, tasks } = createProject({ title: '曲A' }, lib.templates[0], lib);
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
