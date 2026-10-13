// ドメインロジックと保存まわりの簡易テスト。test.html をブラウザで開くと実行される。
// Node でも動く: node -e "import('./test/domain.test.js').then(m => m.report()).then(ok => process.exit(ok ? 0 : 1))"

import { orderAtEnd, orderBetween, placeAt, reorder, sortByOrder } from '../js/domain/order.js';
import {
   addSection, assertSection, colorsInOrder, createProject, createTemplate, daysUntilDue, duplicateLane, moveLane,
   normalizeDueDate, renameLane, SECTION_COLORS, sectionColors, uniqueLaneName, updateProject,
} from '../js/domain/project.js';
import { summarize, summarizeByLane } from '../js/domain/stats.js';
import {
   addTask, cycleStatus, isValidPeriod, moveTask, setStatus, updateTask,
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

// 初期データのテンプレート(レーンとタスク)。createProject などの元として使う
const seed = buildSeed();
const template = (key) => ({
   lanes: seed.lanes.filter((l) => l.projectId === `seed-template-${key}`),
   tasks: seed.tasks.filter((t) => t.projectId === `seed-template-${key}`),
});
const sectionNames = (lanes) => titles(lanes.filter((l) => l.type === 'section'));
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

test('createProject: テンプレートのレーンとタスクを丸ごとコピーする', () => {
   const source = template('vocal');
   const before = JSON.stringify(source);
   const { project, lanes, tasks } = createProject({ title: ' 新曲 ' }, source);
   equal(JSON.stringify(source), before, 'テンプレートは変更しない');
   equal([project.title, project.isTemplate], ['新曲', false]);
   assert(!('templateId' in project), '作成元は覚えない');
   equal(sectionNames(lanes),
      ['イントロ', 'Aメロ', 'Bメロ', 'サビ', '間奏', 'Aメロ2', 'Bメロ2', 'サビ2', 'Cメロ', 'サビ3', 'アウトロ']);
   equal(titles(lanes.filter((l) => l.type === 'global')), ['全体']);
   assert(lanes.every((l) => l.projectId === project.id && l.collapsed === false && !('kindId' in l)));

   const chorus = lanes.find((l) => l.name === 'サビ2');
   equal(titles(tasks.filter((t) => t.laneId === chorus.id)),
      ['コード確定', 'メロ確定', 'ドラム', 'ベース', '上モノ', 'コーラス']);
   const global = lanes.find((l) => l.type === 'global');
   equal(titles(tasks.filter((t) => t.laneId === global.id)),
      ['テンポ・キー決定', '仮タイトル', '歌詞', 'ミックス', 'マスタリング', '書き出し']);
   assert(tasks.every((t) => t.status === 'todo' && t.doneAt === null && t.projectId === project.id));
   equal(tasks.length, 6 * 3 + 4 * 2 + 6);

   // コピーは別のIDを持ち、テンプレートのレコードを指さない
   const sourceIds = new Set([...source.lanes, ...source.tasks].map((r) => r.id));
   assert([...lanes, ...tasks].every((r) => !sourceIds.has(r.id)), 'IDは新しい');
   assert(tasks.every((t) => lanes.some((l) => l.id === t.laneId)), 'タスクはコピーしたレーンに入る');
});

test('createProject: 「全体」レーンは必ず1本。テンプレートごとに中身が違う', () => {
   for (const [source, count] of [[template('vocal'), 6], [template('inst'), 5], [null, 0]]) {
      const { lanes, tasks } = createProject({ title: 'x' }, source);
      const globals = lanes.filter((l) => l.type === 'global');
      equal(globals.map((l) => l.name), ['全体']);
      equal(tasks.filter((t) => t.laneId === globals[0].id).length, count);
   }
   const inst = createProject({ title: 'x' }, template('inst'));
   assert(!titles(inst.tasks).includes('歌詞'), 'インストの「全体」に歌詞はない');
   equal(sectionNames(inst.lanes), ['セクション', 'セクション2', 'セクション3', 'セクション4']);
   const none = createProject({ title: '' });
   equal([none.project.title, none.project.isTemplate], ['無題のプロジェクト', false]);
   equal([none.lanes.length, none.tasks.length], [1, 0]);
});

test('createProject: 作業中のステータスやメモ、折りたたみを持つ元からでも、未着手で作る', () => {
   const source = template('vocal');
   const worked = {
      lanes: source.lanes.map((l) => ({ ...l, collapsed: true })),
      tasks: source.tasks.map((t, i) => ({ ...setStatus(t, i % 2 ? 'done' : 'doing'), memo: 'メモ' })),
   };
   const { lanes, tasks } = createProject({ title: 'x' }, worked);
   assert(lanes.every((l) => l.collapsed === false));
   assert(tasks.every((t) => t.status === 'todo' && t.doneAt === null && t.memo === 'メモ'));
});

test('createTemplate: 新規・複製・プロジェクトからの保存', () => {
   const empty = createTemplate({ name: ' クラブ ' });
   equal([empty.project.title, empty.project.isTemplate, empty.project.dueDate], ['クラブ', true, null]);
   equal([empty.lanes.map((l) => l.type), empty.tasks.length], [['global'], 0]);
   throws(() => createTemplate({ name: '  ' }));

   // 複製: 中身が同じで、IDは別
   const copy = createTemplate({ name: '歌モノのコピー', memo: 'm' }, template('vocal'));
   equal([copy.project.memo, copy.lanes.length, copy.tasks.length], ['m', 12, 32]);
   equal(sectionNames(copy.lanes), sectionNames(template('vocal').lanes));
   assert(copy.lanes.every((l) => l.projectId === copy.project.id && !template('vocal').lanes.some((s) => s.id === l.id)));

   // プロジェクトからの保存: セクションごとの違いも、足したセクションも落ちない
   const { project, lanes, tasks } = createProject({ title: '曲', dueDate: '2026-10-31' }, template('vocal'));
   const lane = (name) => lanes.find((l) => l.name === name);
   const extra = setStatus(addTask(lane('サビ3'), tasks.filter((t) => t.laneId === lane('サビ3').id), '落ちサビ用の抜き'), 'done');
   const added = addSection({ projectId: project.id, lanes, name: 'ドロップ', index: 1 });
   const drop = addTask(added.lane, [], 'ベースを抜く');
   const saved = createTemplate({ name: '曲の型' }, { lanes: [...lanes, added.lane], tasks: [...tasks, extra, drop] });
   equal(saved.project.isTemplate, true);
   equal(sectionNames(saved.lanes).slice(0, 3), ['イントロ', 'ドロップ', 'Aメロ']);
   const tasksOf = (name) => titles(saved.tasks.filter((t) => t.laneId === saved.lanes.find((l) => l.name === name).id));
   equal(tasksOf('サビ').length, 6);
   equal(tasksOf('サビ3').at(-1), '落ちサビ用の抜き', 'サビ3だけの違いも残る');
   equal(tasksOf('ドロップ'), ['ベースを抜く']);
   assert(saved.tasks.every((t) => t.status === 'todo'), 'ステータスは引き継がない');

   // 保存したテンプレートから作ると、同じ構成になる
   const next = createProject({ title: '次の曲' }, saved);
   equal(sectionNames(next.lanes), sectionNames(saved.lanes));
   equal(next.tasks.length, saved.tasks.length);
});

test('「全体」レーンは名前変更・複製・削除できない', () => {
   const { lanes, tasks } = createProject({ title: 'x' }, template('inst'));
   const global = lanes.find((l) => l.type === 'global');
   throws(() => renameLane(global, 'ミックス'), '名前変更');
   throws(() => duplicateLane(global.id, lanes, tasks), '複製');
   throws(() => assertSection(global, '削除'), '削除');
   assertSection(lanes.find((l) => l.type === 'section'), '削除');
});

test('updateProject: 空タイトルは拒否', () => {
   const { project } = createProject({ title: 'x' });
   equal(updateProject(project, { title: ' y ', memo: 'm' }).title, 'y');
   throws(() => updateProject(project, { title: '  ' }));
   // テンプレートの名前とメモも同じ操作で編集する
   const edited = updateProject(createTemplate({ name: 't' }).project, { title: 'EDM', memo: 'm' });
   equal([edited.title, edited.memo, edited.isTemplate], ['EDM', 'm', true]);
});

test('締切: 作成・編集で持てる。空や不正な日付は締切なし', () => {
   equal(createProject({ title: 'x' }).project.dueDate, null);
   const { project } = createProject({ title: 'x', dueDate: '2026-10-31' });
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

test('addSection: 空のセクションを、指定位置か末尾に足す', () => {
   const { project, lanes } = createProject({ title: 'x' }, template('vocal'));
   const base = { projectId: project.id, lanes };
   const added = addSection({ ...base, name: ' ブレイク ', index: 1 });
   equal([added.lane.name, added.lane.type, added.tasks.length], ['ブレイク', 'section', 0]);
   equal(added.lanes.length, 1, '他のレーンは書き換えない');
   equal(sectionNames([...lanes, added.lane]).slice(0, 3), ['イントロ', 'ブレイク', 'Aメロ']);

   const last = addSection(base);
   equal(last.lane.name, 'セクション', '名前を省略したとき');
   equal(sectionNames([...lanes, last.lane]).at(-1), 'セクション');
   equal(addSection({ ...base, name: 'サビ' }).lane.name, 'サビ4', '名前が重なったら番号を振る');
});

test('addSection: テンプレートのセクションをタスクごと取り込む', () => {
   const { project, lanes } = createProject({ title: 'x' }, template('inst'));
   const from = template('vocal');
   const chorus = from.lanes.find((l) => l.name === 'サビ2');
   const source = { lane: chorus, tasks: from.tasks.filter((t) => t.laneId === chorus.id).map((t) => ({ ...t, memo: 'm' })) };

   const added = addSection({ projectId: project.id, lanes, index: 1, source });
   equal(added.lane.name, 'サビ', '取り込み元の名前から番号を除いて付ける');
   equal([added.lane.projectId, added.lane.collapsed], [project.id, false]);
   equal(titles(added.tasks), ['コード確定', 'メロ確定', 'ドラム', 'ベース', '上モノ', 'コーラス']);
   assert(added.tasks.every((t) => t.laneId === added.lane.id && t.projectId === project.id && t.memo === 'm' && t.status === 'todo'));
   assert(added.tasks.every((t) => !from.tasks.some((s) => s.id === t.id)), 'タスクのIDは新しい');
   assert(!('sourceLaneId' in added.lane) && !('kindId' in added.lane), '取り込み元とのつながりは残さない');
   equal(sectionNames([...lanes, added.lane]), ['セクション', 'サビ', 'セクション2', 'セクション3', 'セクション4']);

   // もう1本取り込むと番号が付く。名前を指定すれば、その名前になる
   const all = [...lanes, added.lane];
   equal(addSection({ projectId: project.id, lanes: all, source }).lane.name, 'サビ2');
   const named = addSection({ projectId: project.id, lanes: all, source, name: '落ちサビ' });
   equal([named.lane.name, named.tasks.length], ['落ちサビ', 6]);
});

test('duplicateLane: タスクごと複製し、ステータスは未着手に戻す', () => {
   const { lanes, tasks } = createProject({ title: 'x' }, template('vocal'));
   const source = lanes.find((l) => l.name === 'サビ');
   const worked = tasks.map((t, i) => (t.laneId === source.id
      ? { ...setStatus(t, i % 2 ? 'done' : 'doing'), memo: 'メモ' }
      : t));
   const dup = duplicateLane(source.id, lanes, worked);
   equal(dup.lane.name, 'サビ4');
   equal(dup.tasks.length, 6);
   assert(dup.tasks.every((t) => t.status === 'todo' && t.doneAt === null && t.memo === 'メモ'));
   assert(dup.tasks.every((t) => t.laneId === dup.lane.id && !worked.some((w) => w.id === t.id)));
   equal(titles(dup.tasks), titles(worked.filter((t) => t.laneId === source.id)));
   equal(sectionNames(apply([...lanes, dup.lane], dup.lanes)).slice(3, 5), ['サビ', 'サビ4'], '元のレーンの直後');
});

test('moveLane: 同じ種類の中だけで並べ替える', () => {
   const { lanes } = createProject({ title: 'x' }, template('inst'));
   const sections = sortByOrder(lanes.filter((l) => l.type === 'section'));
   const moved = apply(lanes, moveLane(lanes, sections[0].id, 3));
   equal(sectionNames(moved), ['セクション2', 'セクション3', 'セクション4', 'セクション']);
   equal(moved.find((l) => l.type === 'global').order, lanes.find((l) => l.type === 'global').order);
});

test('sectionColors: 並び順にパレットの色を割り振る。名前(末尾の番号を除く)が同じなら同じ色', () => {
   const { lanes } = createProject({ title: 'x' }, template('vocal'));
   const colorOf = (all, name) => sectionColors(all).get(all.find((l) => l.name === name).id);
   const [c1, c2, c3, c4] = SECTION_COLORS;
   equal(['イントロ', 'Aメロ', 'Bメロ', 'サビ'].map((n) => colorOf(lanes, n)), [c1, c2, c3, c4]);
   equal(['Aメロ2', 'サビ2', 'サビ3'].map((n) => colorOf(lanes, n)), [c2, c4, c4], '同じ名前は同じ色');
   equal(colorOf(lanes, 'アウトロ'), SECTION_COLORS[6]);
   assert(!sectionColors(lanes).has(lanes.find((l) => l.type === 'global').id), '「全体」レーンには割り振らない');

   // 並べ替えると、位置に合わせて色が入れ替わる
   const sections = sortByOrder(lanes.filter((l) => l.type === 'section'));
   const moved = apply(lanes, moveLane(lanes, sections[2].id, 1));
   equal(['イントロ', 'Bメロ', 'Aメロ', 'サビ'].map((n) => colorOf(moved, n)), [c1, c2, c3, c4]);
   equal(colorOf(moved, 'Aメロ2'), c3);
   // 色は名前で決まるので、名前を変えると別の色になる
   const renamed = apply(lanes, [renameLane(lanes.find((l) => l.name === 'サビ3'), '落ちサビ')]);
   equal([colorOf(renamed, 'サビ2'), colorOf(renamed, '落ちサビ')], [c4, SECTION_COLORS[6]]);
   equal(colorOf(renamed, 'アウトロ'), SECTION_COLORS[7], '後ろのセクションは1つずれる');
});

test('sectionColors: 色を使い切ったら先頭に戻る', () => {
   const many = colorsInOrder(Array.from({ length: SECTION_COLORS.length + 2 }, (_, i) => `k${i}`));
   equal(many.slice(-2), SECTION_COLORS.slice(0, 2));
   equal(new Set(SECTION_COLORS).size, 18, 'パレットは重複のない18色');
});

test('renameLane: 空の名前は拒否', () => {
   const { lanes } = createProject({ title: 'x' }, template('inst'));
   const section = lanes.find((l) => l.type === 'section');
   equal(renameLane(section, ' ドロップ ').name, 'ドロップ');
   throws(() => renameLane(section, ''));
});

// ---- task ----

function fixture() {
   const { project, lanes, tasks } = createProject({ title: 'x' }, template('vocal'));
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

test('開始日と終了日: コピーには引き継がない(テンプレートに入らない)', () => {
   const { project, lanes, tasks } = fixture();
   const dated = tasks.map((t) => setStatus(t, 'done'));
   assert(dated.every((t) => t.startDate && t.endDate));
   const noDates = (list) => list.length > 0 && list.every((t) => t.startDate === null && t.endDate === null);
   assert(noDates(createTemplate({ name: '型' }, { lanes, tasks: dated }).tasks), 'テンプレートとして保存');
   assert(noDates(createProject({ title: 'x' }, { lanes, tasks: dated }).tasks), 'テンプレートから作成');
   const chorus = lanes.find((l) => l.name === 'サビ');
   assert(noDates(duplicateLane(chorus.id, lanes, dated).tasks), 'セクションの複製');
   const source = { lane: chorus, tasks: dated.filter((t) => t.laneId === chorus.id) };
   assert(noDates(addSection({ projectId: project.id, lanes, source }).tasks), 'セクションの取り込み');
   assert(noDates(buildSeed().tasks), '初期データ');
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

// ---- store(DOM非依存の部分) ----

test('migrate: 検証して形を揃える', () => {
   const data = migrate(JSON.stringify({ schemaVersion: SCHEMA_VERSION, projects: [{ id: 'p' }] }));
   equal([data.schemaVersion, data.projects.length, data.lanes.length, data.tasks.length], [SCHEMA_VERSION, 1, 0, 0]);
   throws(() => migrate('not json'));
   throws(() => migrate({ projects: [] }), 'schemaVersion なし');
   throws(() => migrate({ schemaVersion: SCHEMA_VERSION + 1 }), '新しすぎる');
   throws(() => migrate({ schemaVersion: SCHEMA_VERSION, tasks: [{}] }), 'id なし');
});

test('migrate: 開始日と終了日を持つ前のデータ(v4)は、日付なしとして読み込む', () => {
   const data = migrate({ schemaVersion: 4, tasks: [{ id: 'a' }, { id: 'b', startDate: '2026-10-20', endDate: null }] });
   equal(data.schemaVersion, SCHEMA_VERSION);
   equal(data.tasks, [{ id: 'a', startDate: null, endDate: null }, { id: 'b', startDate: '2026-10-20', endDate: null }]);
});

test('migrate: テンプレートの持ち方を変える前のデータは読み込まない', () => {
   for (const schemaVersion of [1, 2, 3]) {
      let message = '';
      try {
         migrate({ schemaVersion, projects: [], templates: [] });
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
   const { project, lanes, tasks } = createProject({ title: 'x', dueDate: '2026-10-31' }, template('vocal'));
   const row = toRow(tasks[0]);
   equal(Object.keys(row).sort(), ['created_at', 'done_at', 'end_date', 'id', 'lane_id', 'memo', 'project_id',
      'sort_order', 'start_date', 'status', 'title', 'updated_at']);
   const dated = setStatus(tasks[0], 'done');
   equal(fromRow(toRow(dated)), dated, '開始日と終了日は日付のまま往復する');
   equal(fromRow(row), tasks[0], '往復しても変わらない');
   equal(Object.keys(toRow(project)).sort(), ['created_at', 'due_date', 'id', 'is_template', 'memo', 'title', 'updated_at']);
   equal(Object.keys(toRow(lanes[0])).sort(), ['collapsed', 'created_at', 'id', 'name', 'project_id', 'sort_order', 'type', 'updated_at']);
   // データベースは日時を +00:00 の形で返す。IndexedDB 実装と同じ …Z に揃える
   const back = fromRow({ created_at: '2026-10-12T04:25:44.487+00:00', done_at: null, due_date: '2026-10-31' });
   equal(back, { createdAt: '2026-10-12T04:25:44.487Z', doneAt: null, dueDate: '2026-10-31' });
});

test('supabase: 保存して読み戻せる。初期データの投入は1回だけ', async () => {
   const { tables, repository } = fakeSupabase();
   equal(await ensureSeeded(repository), true);
   equal(await ensureSeeded(repository), false, '2回目は入れない');
   // 初期データはテンプレート2つ。プロジェクトと同じテーブルに入る
   equal(Object.keys(tables).sort(), ['app_meta', 'lanes', 'projects', 'tasks']);
   equal([tables.projects.length, tables.lanes.length, tables.tasks.length], [2, 17, 37]);
   assert('sort_order' in tables.lanes[0] && !('order' in tables.lanes[0]), '列名は sort_order');
   assert(tables.projects.every((r) => r.is_template === true), '列名は is_template');
   equal((await repository.getTemplates()).map((t) => t.title).sort(), ['インスト', '歌モノ']);
   equal(await repository.getProjects(), [], 'テンプレートはプロジェクト一覧に混ざらない');

   const source = { lanes: await repository.getLanes('seed-template-vocal'), tasks: await repository.getTasks('seed-template-vocal') };
   const { project, lanes, tasks } = createProject({ title: '曲A', dueDate: '2026-10-31' }, source);
   const other = createProject({ title: '曲B' });
   for (const p of [{ project, lanes, tasks }, other]) {
      await repository.saveProject(p.project);
      await repository.saveLanes(p.lanes);
      await repository.saveTasks(p.tasks);
   }
   equal(await repository.getProject(project.id), project);
   equal((await repository.getProject('seed-template-vocal')).isTemplate, true, 'getProject はテンプレートも返す');
   equal(await repository.getProject('missing'), null);
   equal((await repository.getProjects()).map((p) => p.title).sort(), ['曲A', '曲B']);
   equal((await repository.getTemplates()).length, 2);
   equal(ids(await repository.getLanes(project.id)), ids(lanes), 'プロジェクトで絞る');
   equal((await repository.getTasks(project.id)).length, 32);
   equal((await repository.getTasks(other.project.id)).length, 0);

   await repository.saveTask({ ...tasks[0], title: '変更' });
   const saved = (await repository.getTasks(project.id)).find((t) => t.id === tasks[0].id);
   equal([saved.title, tables.tasks.filter((r) => r.project_id === project.id).length], ['変更', tasks.length], '同じIDは上書き');
   await repository.deleteTask(tasks[0].id);
   equal((await repository.getTasks(project.id)).length, tasks.length - 1);
   // テンプレートの削除はプロジェクトと同じ(レーンとタスクは、データベース側の cascade で消える)
   await repository.deleteProject('seed-template-inst');
   equal((await repository.getTemplates()).map((t) => t.id), ['seed-template-vocal']);
});

test('supabase: 1回の上限(1000行)を超えても全部読める', async () => {
   const { repository } = fakeSupabase();
   const { project, lanes } = createProject({ title: 'x' });
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
   const { project, lanes, tasks } = createProject({ title: '曲A' }, template('inst'));
   await a.saveProject(project);
   await a.saveLanes(lanes);
   await a.saveTasks(tasks);
   const exported = await a.exportAll();
   equal([exported.schemaVersion, exported.projects.length, exported.lanes.length, exported.tasks.length],
      [SCHEMA_VERSION, 3, 17 + 5, 37 + 5], 'テンプレートも含む');

   const b = fakeSupabase().repository;
   const old = createProject({ title: '消える' });
   await b.saveProject(old.project);
   await b.saveLanes(old.lanes);
   await b.importAll(JSON.stringify(exported));
   equal((await b.getProjects()).map((p) => p.title), ['曲A']);
   equal((await b.getTemplates()).length, 2);
   equal((await b.getLanes(old.project.id)).length, 0);
   equal((await b.getTasks(project.id)).length, tasks.length);
   equal((await b.getTasks('seed-template-vocal')).length, 32);
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
