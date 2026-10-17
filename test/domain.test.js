// ドメインロジックと保存まわりの簡易テスト。test.html をブラウザで開くと実行される。
// Node でも動く: node -e "import('./test/domain.test.js').then(m => m.report()).then(ok => process.exit(ok ? 0 : 1))"

import {
   addClip, addMarker, addTrack, arrangementBars, canPlace, clipEnd, clipSection, markerSpans, moveTrack, placeClip,
   renameTrack, setClipNotes, syncClipTasks, updateClip, updateMarker, updateTrackSound,
} from '../js/domain/arrangement.js';
import {
   audibleNotes, buildMidiFile, clipTicks, inScale, MAX_BPM, midiFileName, MIN_BPM, moveScale, normalizeBpm, normalizeNotes,
   normalizeScale, normalizeScales, noteEvents, PPQ, projectBpm, projectScales, removeScale, scaleAt, scaleLabel, scaleSpans,
   secondsToTicks, setScaleAt, soundLabel, TICKS_PER_BAR, ticksToSeconds, trackChannels, trackSound, varLen,
} from '../js/domain/midi.js';
import { addDays, daysBetween, toDateString, weekendDaysBetween } from '../js/domain/date.js';
import { deadlineRange, deadlineRows } from '../js/domain/deadline.js';
import { ganttRange, ganttRows } from '../js/domain/gantt.js';
import { orderAtEnd, orderBetween, placeAt, reorder, sortByOrder } from '../js/domain/order.js';
import {
   addSection, assertSection, createProject, createTemplate, daysUntilDue, duplicateLane, moveLane,
   normalizeDueDate, renameLane, SECTION_COLORS, sectionColors, uniqueLaneName, updateProject,
} from '../js/domain/project.js';
import {
   canonicalizeReference, cleanReferences, collectReferences, listReferences, normalizeReference, suggestReferences,
} from '../js/domain/reference.js';
import { isFinished, summarize, summarizeByLane } from '../js/domain/stats.js';
import {
   addTask, cycleStatus, isValidPeriod, moveTask, setStatus, updateTask,
} from '../js/domain/task.js';
import { normalizeProjectUrl } from '../js/session.js';
import { buildSeed, ensureSeeded } from '../js/store/seed.js';
import { checkConnection, createSupabaseRepository, fromRow, toRow } from '../js/store/supabase.js';
import { checkSchema, migrate, NewerSchemaError, SCHEMA_VERSION, upgradeStorage } from '../js/store/repository.js';

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

test('sectionColors: 並び順にパレットの色を1色ずつ割り振る。名前が似ていても別の色', () => {
   const { lanes } = createProject({ title: 'x' }, template('vocal'));
   const colorOf = (all, name) => sectionColors(all).get(all.find((l) => l.name === name).id);
   const [c1, c2, c3, c4] = SECTION_COLORS;
   equal(['イントロ', 'Aメロ', 'Bメロ', 'サビ'].map((n) => colorOf(lanes, n)), [c1, c2, c3, c4]);
   equal(['Aメロ2', 'サビ2', 'サビ3'].map((n) => colorOf(lanes, n)), [SECTION_COLORS[5], SECTION_COLORS[7], SECTION_COLORS[9]],
      '「サビ」と「サビ2」も別の色');
   equal(colorOf(lanes, 'アウトロ'), SECTION_COLORS[10]);
   assert(!sectionColors(lanes).has(lanes.find((l) => l.type === 'global').id), '「全体」レーンには割り振らない');

   // 並べ替えると、位置に合わせて色が入れ替わる
   const sections = sortByOrder(lanes.filter((l) => l.type === 'section'));
   const moved = apply(lanes, moveLane(lanes, sections[2].id, 1));
   equal(['イントロ', 'Bメロ', 'Aメロ', 'サビ'].map((n) => colorOf(moved, n)), [c1, c2, c3, c4]);
   // 色は位置だけで決まるので、名前を変えても変わらない
   const renamed = apply(lanes, [renameLane(lanes.find((l) => l.name === 'サビ3'), '落ちサビ')]);
   equal(colorOf(renamed, '落ちサビ'), SECTION_COLORS[9]);
});

test('sectionColors: 色を使い切ったら先頭に戻る', () => {
   const lanes = Array.from({ length: SECTION_COLORS.length + 2 }, (_, i) => ({ id: `k${i}`, type: 'section', order: i }));
   const colors = lanes.map((l) => sectionColors(lanes).get(l.id));
   equal(colors.slice(-2), SECTION_COLORS.slice(0, 2));
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

// ---- reference ----

test('normalizeReference: 全角・半角、大文字・小文字、空白、記号の違いを無視する', () => {
   equal(normalizeReference('ｱｲﾄﾞﾙ'), normalizeReference('アイドル'));
   equal(normalizeReference(' Ｂｏｈｅｍｉａｎ  Rhapsody '), 'bohemianrhapsody');
   equal(normalizeReference("Don't Stop Me Now!"), normalizeReference('dont stop me now'));
   equal(normalizeReference('!!!'), '!!!', '記号だけなら記号を残す');
   equal(normalizeReference('  '), '');
});

test('cleanReferences: 空と、表記の違いだけで同じものを落とす(先に出た表記を残す)', () => {
   equal(cleanReferences([' 夜に駆ける ', '', '夜に駆ける', 'Lemon', 'lemon', '   ']), ['夜に駆ける', 'Lemon']);
   equal(cleanReferences(undefined), []);
});

test('collectReferences: プロジェクトの曲名を、よく使う順にまとめる', () => {
   const tasks = [
      { references: ['Lemon', '夜に駆ける'] },
      { references: ['lemon'] },
      {},
      { references: ['アイドル', 'ＬＥＭＯＮ'] },
   ];
   equal(collectReferences(tasks), ['Lemon', 'アイドル', '夜に駆ける']);
});

test('listReferences: 一覧の画面には、まとめた曲名を名前順に出す', () => {
   const tasks = [
      { references: ['夜に駆ける', 'Lemon'] },
      { references: ['lemon', 'アイドル'] },
      {},
   ];
   equal(listReferences(tasks), ['Lemon', 'アイドル', '夜に駆ける']);
   equal(listReferences([]), []);
});

test('suggestReferences: 前方一致を先に、部分一致を後に。付いているものは出さない', () => {
   const known = ['Lemon', 'アイドル', 'Pale Blue', 'Blue Bird'];
   equal(suggestReferences('blue', known), ['Blue Bird', 'Pale Blue']);
   equal(suggestReferences('ｱｲ', known), ['アイドル']);
   equal(suggestReferences('', known, ['lemon']), ['アイドル', 'Pale Blue', 'Blue Bird']);
   equal(suggestReferences('zzz', known), []);
});

test('canonicalizeReference: 表記の違いだけなら既存の表記に揃える', () => {
   const known = ['アイドル', 'Lemon'];
   equal(canonicalizeReference('ｱｲﾄﾞﾙ', known), 'アイドル');
   equal(canonicalizeReference(' LEMON ', known), 'Lemon');
   equal(canonicalizeReference(' 新しい曲 ', known), '新しい曲');
});

test('updateTask: リファレンスを整えて保存する', () => {
   const { tasks } = fixture();
   equal(tasks[0].references, [], '初めはなし');
   equal(updateTask(tasks[0], { references: [' Lemon ', 'lemon', ''] }).references, ['Lemon']);
   equal(updateTask(tasks[0], { title: 'y' }).references, [], '他の項目だけ編集しても変わらない');
});

test('リファレンス: セクションの複製では引き継ぎ、テンプレートとのやり取りでは引き継がない', () => {
   const { project, lanes, tasks } = fixture();
   const withRefs = tasks.map((t) => updateTask(t, { references: ['Lemon'] }));
   const none = (list) => list.length > 0 && list.every((t) => t.references.length === 0);
   assert(none(createTemplate({ name: '型' }, { lanes, tasks: withRefs }).tasks), 'テンプレートとして保存');
   assert(none(createProject({ title: 'x' }, { lanes, tasks: withRefs }).tasks), 'テンプレートから作成');
   const chorus = lanes.find((l) => l.name === 'サビ');
   const source = { lane: chorus, tasks: withRefs.filter((t) => t.laneId === chorus.id) };
   assert(none(addSection({ projectId: project.id, lanes, source }).tasks), 'セクションの取り込み');
   const dup = duplicateLane(chorus.id, lanes, withRefs).tasks;
   assert(dup.length > 0 && dup.every((t) => t.references[0] === 'Lemon'), 'セクションの複製');
   assert(dup[0].references !== source.tasks[0].references, '配列は共有しない');
   // リファレンスを持つ前に作ったタスク(項目がない)でも複製できる
   const { references, ...old } = tasks.find((t) => t.laneId === chorus.id);
   equal(duplicateLane(chorus.id, lanes, [old]).tasks[0].references, []);
});

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

test('ganttRows: 着手済みで開始日のあるタスクを、開始日の早い順に出す', () => {
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
      ['コード確定', '2026-10-05', '2026-10-08', false],
      ['テンポ・キー決定', '2026-10-05', today, true],
      ['仮タイトル', '2026-10-07', '2026-10-09', false],
      ['コード確定', '2026-10-10', '2026-10-10', false],
      ['メロ確定', '2026-10-10', today, true],
   ]);
   equal([rows[0].lane.id, rows[3].lane.id], [lane('サビ').id, lane('Aメロ').id], 'レーンも返す');
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

// ---- arrangement ----

function arrangementFixture() {
   const { project, lanes } = createProject({ title: 'x' }, template('vocal'));
   const lane = (name) => lanes.find((l) => l.name === name);
   const synth = addTrack(project.id, [], 'シンセ');
   const drums = addTrack(project.id, [synth], 'ドラム');
   const a = addClip(synth, [], { startBar: 1, bars: 4, name: ' イントロ ' });
   const b = addClip(synth, [a], { startBar: 9, bars: 2 });
   return { project, lanes, lane, synth, drums, clips: [a, b], a, b };
}

test('addTrack: 末尾に追加し、名前が重なったら番号を振る。空なら「トラック」', () => {
   const one = addTrack('p', []);
   const two = addTrack('p', [one], ' ');
   const three = addTrack('p', [one, two], 'Bass');
   equal([one.name, two.name, three.name], ['トラック', 'トラック2', 'Bass']);
   assert(one.order < two.order && two.order < three.order, '末尾に足す');
   equal(titles(apply([one, two, three], moveTrack([one, two, three], three.id, 0))), ['Bass', 'トラック', 'トラック2']);
   equal(renameTrack(one, ' Lead ').name, 'Lead');
   throws(() => renameTrack(one, ' '), '空の名前は拒否');
});

test('addClip: 同じトラックでは重ならない。別のトラックなら同じ小節に置ける', () => {
   const { synth, drums, clips, a, b } = arrangementFixture();
   equal([a.name, a.memo, a.trackId, clipEnd(a), clipEnd(b)], ['イントロ', '', synth.id, 4, 10]);
   throws(() => addClip(synth, clips, { startBar: 4, bars: 1 }), '終わりの小節に重なる');
   throws(() => addClip(synth, clips, { startBar: 7, bars: 3 }), '後ろのクリップに重なる');
   equal(addClip(synth, clips, { startBar: 5, bars: 4 }).startBar, 5, 'ちょうど隙間に収まる');
   equal(addClip(drums, clips, { startBar: 1, bars: 16 }).trackId, drums.id, '別のトラック');
   throws(() => addClip(synth, [], { startBar: 0, bars: 1 }), '0小節目はない');
   throws(() => addClip(synth, [], { startBar: 1, bars: 0 }), '長さは1以上');
   throws(() => addClip(synth, [], { startBar: 1.5, bars: 1 }), '整数だけ');
   equal(canPlace(clips, { trackId: synth.id, startBar: 3, bars: 2 }, a.id), true, '自分自身とは重ならない');
});

test('placeClip: 移動・伸縮・トラック間の移動。重なるなら拒否', () => {
   const { synth, drums, clips, a, b } = arrangementFixture();
   equal([placeClip(clips, a.id, { startBar: 3 }).startBar, placeClip(clips, a.id, { bars: 8 }).bars], [3, 8]);
   throws(() => placeClip(clips, a.id, { startBar: 7 }), '移動先が重なる');
   throws(() => placeClip(clips, a.id, { bars: 9 }), '伸ばすと重なる');
   const moved = placeClip(clips, b.id, { trackId: drums.id, startBar: 1 });
   equal([moved.trackId, moved.startBar, moved.bars, moved.name], [drums.id, 1, 2, b.name], '別のトラックへ');
   equal(clips.find((c) => c.id === b.id).trackId, synth.id, '元のレコードは変えない');
   equal(updateClip(a, { name: ' ', memo: 'メモ' }), { ...a, name: '', memo: 'メモ', updatedAt: updateClip(a, {}).updatedAt });
});

test('マーカー: セクションを指し、同じ小節には1つだけ。「全体」レーンは置けない', () => {
   const { project, lanes, lane } = arrangementFixture();
   const intro = addMarker(project.id, [], lane('イントロ'), 1);
   const verse = addMarker(project.id, [intro], lane('Aメロ'), 9);
   throws(() => addMarker(project.id, [intro, verse], lane('Bメロ'), 9), '同じ小節');
   throws(() => addMarker(project.id, [], lanes.find((l) => l.type === 'global'), 5), '全体レーン');
   throws(() => addMarker(project.id, [], lane('Bメロ'), 0), '0小節目');
   const markers = [verse, intro];
   const spans = markerSpans(markers, lanes, 32);
   equal(spans.map((s) => [s.lane.name, s.from, s.to]), [['イントロ', 1, 8], ['Aメロ', 9, 32]], '次のマーカーの手前まで');

   throws(() => updateMarker(markers, verse.id, { bar: 1 }), '移動先にマーカーがある');
   equal(updateMarker(markers, verse.id, { bar: 9 }).bar, 9, '自分の小節には置ける');
   const changed = updateMarker(markers, verse.id, { bar: 17, lane: lane('サビ') });
   equal([changed.bar, changed.laneId], [17, lane('サビ').id]);
});

test('arrangementBars: 中身の後ろに余白を取り、4小節単位で伸びる', () => {
   const { clips } = arrangementFixture();
   equal(arrangementBars([], []), 32, '空なら32小節');
   equal(arrangementBars(clips, []), 32, '短いうちは32小節');
   equal(arrangementBars([{ startBar: 30, bars: 3 }], []), 40, '32小節目まで + 余白8');
   equal(arrangementBars([{ startBar: 30, bars: 4 }], []), 44, '33小節目まで + 余白8 を4の倍数に切り上げ');
   equal(arrangementBars([], [{ bar: 41 }]), 52, 'マーカーも数える');
});

// ---- アレンジとボードの連動タスク ----

test('clipSection: 重なる小節がいちばん多いセクション。同じセクションは合計し、同数なら先のもの', () => {
   const { project, lanes, lane } = arrangementFixture();
   const markers = [
      addMarker(project.id, [], lane('イントロ'), 1),
      addMarker(project.id, [], lane('Aメロ'), 9),
      addMarker(project.id, [], lane('サビ'), 17),
      addMarker(project.id, [], lane('Aメロ'), 25),
   ];
   const at = (startBar, bars) => clipSection({ startBar, bars }, markers);
   const name = (laneId) => lanes.find((l) => l.id === laneId)?.name ?? null;
   equal(name(at(1, 4)), 'イントロ', '1つの区間に収まる');
   equal(name(at(6, 7)), 'Aメロ', 'イントロ3小節、Aメロ4小節');
   equal(name(at(5, 8)), 'イントロ', '4小節ずつなら先の区間');
   equal(name(at(15, 16)), 'Aメロ', 'Aメロ 2+6 とサビ 8 は同数で、先に出てくる Aメロ');
   equal(name(at(40, 4)), 'Aメロ', '最後のマーカーは終わりなく続く');
   const late = [addMarker(project.id, [], lane('Bメロ'), 5)];
   equal(clipSection({ startBar: 1, bars: 4 }, late), null, 'マーカーより前は無所属');
   equal(name(clipSection({ startBar: 3, bars: 4 }, late)), 'Bメロ', '一部がはみ出していても、重なっていれば所属');
   equal(clipSection({ startBar: 1, bars: 4 }, []), null, 'マーカーがなければ無所属');
});

test('canPlace / addClip / placeClip: マーカーを渡すと、セクションの区間の外には置けない', () => {
   const { project, synth, lane, clips, a } = arrangementFixture();
   const markers = [addMarker(project.id, [], lane('Aメロ'), 9)];
   const place = (startBar, bars) => ({ trackId: synth.id, startBar, bars });
   equal(canPlace([], place(1, 4), null, markers), false, '区間の外');
   equal(canPlace([], place(6, 4), null, markers), true, '一部がはみ出すのはよい');
   equal(canPlace([], place(1, 4)), true, 'マーカーを渡さなければ、区間は見ない');
   throws(() => addClip(synth, [], { startBar: 1, bars: 2 }, markers), '区間の外には作れない');
   throws(() => addClip(synth, [], { startBar: 20, bars: 2 }, []), 'マーカーがなければ作れない');
   equal(addClip(synth, [], { startBar: 20, bars: 2 }, markers).startBar, 20);
   throws(() => placeClip(clips, a.id, { startBar: 2 }, markers), '区間の外へは動かせない');
   equal(placeClip(clips, a.id, { startBar: 11 }, markers).startBar, 11, '区間の中へは動かせる');
});

function linkedFixture() {
   const { project, lanes, tasks } = createProject({ title: 'x' }, template('vocal'));
   const lane = (name) => lanes.find((l) => l.name === name);
   const synth = addTrack(project.id, [], 'シンセ');
   const drums = addTrack(project.id, [synth], 'ドラム');
   const intro = addMarker(project.id, [], lane('イントロ'), 1);
   const verse = addMarker(project.id, [intro], lane('Aメロ'), 9);
   const a = addClip(synth, [], { startBar: 1, bars: 4, name: 'イントロ' });
   const c = addClip(drums, [], { startBar: 9, bars: 4, name: 'フィル' });
   const b = addClip(synth, [a], { startBar: 9, bars: 2 });
   const state = { lanes, tracks: [synth, drums], clips: [a, c, b], markers: [intro, verse], tasks };
   // 同期して、保存したあとの状態を返す
   const sync = (s) => {
      const { save, remove } = syncClipTasks(s);
      const added = save.filter((t) => !s.tasks.some((x) => x.id === t.id));
      return { ...s, tasks: [...apply(s.tasks, save), ...added].filter((t) => !remove.includes(t.id)) };
   };
   const linkedTo = (s, clip) => s.tasks.find((t) => t.clipId === clip.id);
   return { project, lane, synth, drums, intro, verse, a, b, c, state, sync, linkedTo };
}

test('syncClipTasks: セクションのレーンの末尾に「トラック名: クリップ名」で作る。何度呼んでも同じ', () => {
   const { lane, a, b, c, state, sync, linkedTo } = linkedFixture();
   const synced = sync(state);
   equal([linkedTo(synced, a).title, linkedTo(synced, b).title, linkedTo(synced, c).title],
      ['シンセ: イントロ', 'シンセ: (無題)', 'ドラム: フィル']);
   equal([linkedTo(synced, a).laneId, linkedTo(synced, b).laneId], [lane('イントロ').id, lane('Aメロ').id]);
   equal([linkedTo(synced, a).status, linkedTo(synced, a).clipId], ['todo', a.id]);
   const verseTitles = titles(synced.tasks.filter((t) => t.laneId === lane('Aメロ').id));
   equal(verseTitles.slice(-2), ['シンセ: (無題)', 'ドラム: フィル'], 'ふつうのタスクの後ろに、トラックの順で並ぶ');
   equal(syncClipTasks(synced), { save: [], remove: [] }, '揃っていれば何もしない');
});

test('syncClipTasks: 名前・詳細・所属の変更を反映し、ステータスは残す', () => {
   const { project, lane, synth, a, b, verse, state, sync, linkedTo } = linkedFixture();
   let s = sync(state);
   s = { ...s, tasks: apply(s.tasks, [setStatus(linkedTo(s, b), 'doing')]) };

   s = sync({ ...s, tracks: [renameTrack(synth, 'Lead'), s.tracks[1]], clips: apply(s.clips, [updateClip(a, { name: '', memo: 'm' })]) });
   equal([linkedTo(s, a).title, linkedTo(s, a).memo], ['Lead: (無題)', 'm'], 'トラック名・クリップ名・詳細');

   // Aメロのマーカーを後ろへずらすと、9〜10小節目のクリップはイントロに入る(9〜12小節目のフィルも、2小節ずつで先のイントロへ)
   s = sync({ ...s, markers: apply(s.markers, [updateMarker(s.markers, verse.id, { bar: 11 })]) });
   const moved = linkedTo(s, b);
   equal([moved.laneId, moved.status], [lane('イントロ').id, 'doing'], '別のセクションへ移っても状態は残る');
   equal(titles(s.tasks.filter((t) => t.laneId === lane('イントロ').id)).slice(-2), [moved.title, 'ドラム: フィル'], '移った先の末尾');

   // マーカーを全部消すと無所属。ボードにも集計にも出ない
   s = sync({ ...s, markers: [] });
   equal(s.tasks.filter((t) => t.clipId).map((t) => t.laneId), [null, null, null]);
   equal(summarize(s.tasks).total, s.tasks.filter((t) => !t.clipId).length, '無所属は数えない');
   equal(ganttRows(s.tasks, s.lanes, toDateString(new Date())), [], '無所属はガントチャートにも出ない');

   // マーカーを置き直すと、元の状態で戻る
   s = sync({ ...s, markers: [addMarker(project.id, [], lane('サビ'), 1)] });
   equal([linkedTo(s, b).laneId, linkedTo(s, b).status], [lane('サビ').id, 'doing']);
});

test('syncClipTasks: クリップがなくなれば消す。同じクリップに2つあれば古い方を残す', () => {
   const { a, b, state, sync, linkedTo } = linkedFixture();
   const s = sync(state);
   const task = linkedTo(s, a);
   equal(syncClipTasks({ ...s, clips: s.clips.filter((c) => c.id !== a.id) }).remove, [task.id]);
   const twin = { ...linkedTo(s, b), id: 'twin', createdAt: '9999-01-01T00:00:00.000Z' };
   equal(syncClipTasks({ ...s, tasks: [...s.tasks, twin] }).remove, ['twin']);
});

test('連動タスク: 別のレーンへは動かせず、名前はクリップで変える。テンプレートと複製にはコピーしない', () => {
   const { lane, a, state, sync, linkedTo } = linkedFixture();
   const s = sync(state);
   const task = linkedTo(s, a);
   throws(() => moveTask(s.tasks, task.id, lane('サビ').id, 0), '別のセクションへ');
   equal(moveTask(s.tasks, task.id, task.laneId, 0)[0].laneId, task.laneId, 'レーンの中では並べ替えられる');
   throws(() => updateTask(task, { title: 'x' }), 'タイトルは変えられない');
   equal(updateTask(task, { references: ['Lemon'] }).references, ['Lemon']);
   const copied = createTemplate({ name: '型' }, { lanes: s.lanes, tasks: s.tasks }).tasks;
   equal([copied.length, copied.some((t) => t.clipId)], [s.tasks.filter((t) => !t.clipId).length, false], 'テンプレートとして保存');
   equal(duplicateLane(lane('イントロ').id, s.lanes, s.tasks).tasks.some((t) => t.title.startsWith('シンセ')), false, 'セクションの複製');
});

test('migrate: v6 のデータは、セクションに入っているクリップに連動タスクを作る', () => {
   const { project, lane, a, state } = linkedFixture();
   const outside = { ...a, id: 'outside', startBar: 1, bars: 1, trackId: state.tracks[1].id };
   const markers = state.markers.filter((m) => m.laneId === lane('Aメロ').id); // イントロのマーカーなし
   const data = migrate({
      schemaVersion: 6, projects: [project], lanes: state.lanes, tasks: state.tasks,
      tracks: state.tracks, clips: [...state.clips, outside], markers,
   });
   const linked = data.tasks.filter((t) => t.clipId);
   equal(linked.map((t) => t.title).sort(), ['シンセ: (無題)', 'ドラム: フィル'], '区間の外のクリップには作らない');
   equal(data.tasks.filter((t) => !t.clipId).every((t) => t.clipId === null), true, 'ふつうのタスクは clipId: null');
   equal(migrate(data).tasks.length, data.tasks.length, 'v7 のデータには足さない');
});

// ---- MIDI ----

const note = (pitch, start, length = PPQ, velocity = 100) => ({ pitch, start, length, velocity });

test('normalizeNotes: 整数に丸めて範囲に収め、開始位置 → 高さの順に並べる', () => {
   equal(normalizeNotes([
      { pitch: 64.4, start: 480, length: 0 }, { pitch: 200, start: -10.6, length: 120, velocity: 0 }, { pitch: 60, start: 480, length: 240 },
   ]), [note(127, -11, 120, 1), note(60, 480, 240), note(64, 480, 1)]);
   equal(normalizeNotes(undefined), [], '項目がなければなし');
});

test('normalizeBpm / projectBpm: 範囲に収め、項目がなければ 120', () => {
   equal([normalizeBpm(128.556), normalizeBpm(5), normalizeBpm(999), normalizeBpm('x'), projectBpm({})], [128.56, MIN_BPM, MAX_BPM, 120, 120]);
   const { project } = createProject({ title: 'x' });
   equal(project.bpm, 120, '新しいプロジェクトは 120');
   equal(updateProject(project, { bpm: '90' }).bpm, 90);
   equal(createTemplate({ name: 't' }).project.bpm, undefined, 'テンプレートは持たない');
});

test('トラックの音: 既定はピアノ・音量100・パン中央。範囲の外は端に寄せる', () => {
   const track = addTrack('p', [], 'Lead');
   equal(trackSound(track), { program: 0, volume: 100, pan: 64, drum: false });
   equal(trackSound({}), trackSound(track), '項目がない(v7 以前の)トラック');
   const changed = updateTrackSound(track, { program: 300, pan: -5, drum: true });
   equal([changed.program, changed.volume, changed.pan, changed.drum, changed.name], [127, 100, 0, true, 'Lead']);
   equal([soundLabel(track), soundLabel(changed)], ['1. Acoustic Grand Piano', 'ドラム']);
});

test('trackChannels: 並び順に 1ch から。10ch はドラム専用で、16本目からは使い回す', () => {
   const tracks = Array.from({ length: 17 }, (_, i) => ({ id: `t${i}`, drum: i === 1 }));
   const channels = trackChannels(tracks);
   equal(tracks.slice(0, 12).map((t) => channels.get(t.id)), [0, 9, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11]);
   equal([channels.get('t15'), channels.get('t16')], [15, 0], '16本目(ドラムを除いて)で先頭に戻る');
});

test('setClipNotes / audibleNotes: 範囲の外のノートは持つが鳴らさない。終わりで切る', () => {
   const { a } = arrangementFixture(); // 4小節
   equal(a.notes, [], '作ったときはノートなし');
   const clip = setClipNotes(a, [note(60, -PPQ), note(62, 0), note(64, 4 * TICKS_PER_BAR - PPQ, 2 * PPQ), note(65, 4 * TICKS_PER_BAR)]);
   equal(clip.notes.length, 4, '範囲の外も持つ');
   equal(audibleNotes(clip), [note(62, 0), note(64, 4 * TICKS_PER_BAR - PPQ, PPQ)]);
   equal(clipTicks(clip), 4 * TICKS_PER_BAR);
});

test('placeClip: 移動ではノートが付いていき、左端の伸縮では曲の中の同じ位置に残る', () => {
   const { clips, a, b } = arrangementFixture();
   const withNotes = setClipNotes(b, [note(60, 0), note(62, TICKS_PER_BAR)]); // 9〜10小節
   const all = apply(clips, [withNotes]);
   equal(placeClip(all, b.id, { startBar: 12 }).notes, withNotes.notes, '移動');
   equal(placeClip(all, b.id, { bars: 4 }).notes, withNotes.notes, '右端の伸縮');
   const shrunk = placeClip(all, b.id, { startBar: 10, bars: 1 });
   equal(shrunk.notes.map((n) => n.start), [-TICKS_PER_BAR, 0], '左端を縮める(手前のノートは消さない)');
   const grown = placeClip(apply(all, [shrunk]), b.id, { startBar: 8, bars: 3 });
   equal(grown.notes.map((n) => n.start), [TICKS_PER_BAR, 2 * TICKS_PER_BAR], '左端を伸ばす');
   equal(a.notes, [], '他のクリップは変えない');
});

test('noteEvents: 曲の頭からの位置で並べ、同じ位置ではノートオフを先に置く', () => {
   const { synth, drums, a, b } = arrangementFixture();
   const tracks = [synth, updateTrackSound(drums, { drum: true })];
   const clips = [
      setClipNotes(a, [note(60, 0), note(60, PPQ)]),
      setClipNotes(b, [note(48, 0, PPQ, 90)]), // 9小節目
      setClipNotes(addClip(drums, [], { startBar: 2, bars: 1 }), [note(36, 0, 60)]),
   ];
   equal(noteEvents({ tracks, clips }), [
      { tick: 0, data: [0x90, 60, 100] },
      { tick: PPQ, data: [0x80, 60, 0] },
      { tick: PPQ, data: [0x90, 60, 100] },
      { tick: 2 * PPQ, data: [0x80, 60, 0] },
      { tick: TICKS_PER_BAR, data: [0x99, 36, 100] },
      { tick: TICKS_PER_BAR + 60, data: [0x89, 36, 0] },
      { tick: 8 * TICKS_PER_BAR, data: [0x90, 48, 90] },
      { tick: 8 * TICKS_PER_BAR + PPQ, data: [0x80, 48, 0] },
   ]);
   equal(noteEvents({ tracks: [synth], clips }).length, 6, 'トラックのないクリップは鳴らさない');
   equal([ticksToSeconds(TICKS_PER_BAR, 120), secondsToTicks(0.5, 120)], [2, PPQ]);
});

// .mid のバイト列を、チャンクごとに読み戻す(テスト用の簡易パーサー)
function parseMidi(bytes) {
   const text = (at) => String.fromCharCode(...bytes.slice(at, at + 4));
   const u32 = (at) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
   const chunks = [];
   for (let at = 0; at < bytes.length;) {
      const length = u32(at + 4);
      chunks.push({ type: text(at), body: [...bytes.slice(at + 8, at + 8 + length)] });
      at += 8 + length;
   }
   return chunks;
}

test('varLen: 7ビットずつ、続きがあれば最上位ビットを立てる', () => {
   equal([varLen(0), varLen(0x7f), varLen(0x80), varLen(0x3fff), varLen(0x200000)],
      [[0], [0x7f], [0x81, 0x00], [0xff, 0x7f], [0x81, 0x80, 0x80, 0x00]]);
});

test('buildMidiFile: フォーマット1。テンポのトラックと、トラックごとに名前・音色・音量・パン・ノート', () => {
   const { synth, a } = arrangementFixture();
   const track = updateTrackSound(synth, { program: 81, volume: 90, pan: 32 });
   const clip = setClipNotes(placeClip([a], a.id, { startBar: 3 }), [note(60, 0, 0x80)]);
   const chunks = parseMidi(buildMidiFile({ title: 'Song', bpm: 120, tracks: [track], clips: [clip] }));
   equal(chunks.map((c) => c.type), ['MThd', 'MTrk', 'MTrk']);
   equal(chunks[0].body, [0, 1, 0, 2, 0x01, 0xe0], 'フォーマット1、2トラック、480 tick');
   equal(chunks[1].body, [
      0, 0xff, 0x03, 4, ...[...'Song'].map((c) => c.charCodeAt(0)),
      0, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // 500000 マイクロ秒 = 120 BPM
      0, 0xff, 0x58, 0x04, 4, 2, 24, 8,
      0, 0xff, 0x2f, 0x00,
   ]);
   const name = [...new TextEncoder().encode('シンセ')];
   equal(chunks[2].body, [
      0, 0xff, 0x03, name.length, ...name,
      0, 0xc0, 81, 0, 0xb0, 7, 90, 0, 0xb0, 10, 32,
      ...varLen(2 * TICKS_PER_BAR), 0x90, 60, 100, // 3小節目から
      0x81, 0x00, 0x80, 60, 0,
      0, 0xff, 0x2f, 0x00,
   ]);
   const single = parseMidi(buildMidiFile({ bpm: 120, tracks: [track], clips: [clip], offsetBar: 3 }));
   equal(single[2].body.slice(name.length + 15, name.length + 19), [0, 0x90, 60, 100], 'offsetBar の小節を頭にする');
});

test('midiFileName: 使えない文字とコロンを除く', () => {
   equal(midiFileName('曲: A', 'Lead/1'), '曲_ A - Lead_1.mid');
   equal(midiFileName('', ''), 'clip.mid');
});

test('migrate: v7 のデータは、BPM 120・ピアノ・ノートなしとして読み込む', () => {
   const data = migrate({
      schemaVersion: 7,
      projects: [{ id: 'p', isTemplate: false }, { id: 't', isTemplate: true }],
      tracks: [{ id: 'tr', projectId: 'p' }],
      clips: [{ id: 'c', projectId: 'p', trackId: 'tr', startBar: 1, bars: 1 }],
   });
   equal(data.projects, [{ id: 'p', isTemplate: false, bpm: 120, scales: [{ bar: 1, root: 0, mode: 'major' }] }, { id: 't', isTemplate: true }]);
   equal(data.tracks, [{ id: 'tr', projectId: 'p', program: 0, volume: 100, pan: 64, drum: false }]);
   equal(data.clips[0].notes, []);
});

test('migrate: v8 のデータは1小節目から C メジャー、v9 の scale は1小節目のスケールにする', () => {
   const data = migrate({
      schemaVersion: 9,
      projects: [
         { id: 'p', isTemplate: false, bpm: 90 },
         { id: 'q', isTemplate: false, bpm: 90, scale: { root: 21, mode: 'minor' } },
         { id: 't', isTemplate: true },
      ],
   });
   equal(data.projects.map((p) => p.scales), [[{ bar: 1, root: 0, mode: 'major' }], [{ bar: 1, root: 9, mode: 'minor' }], undefined]);
   assert(!('scale' in data.projects[1]), 'scale は残さない');
});

test('normalizeScale / normalizeScales: 主音は 0〜11、mode は major か minor。1小節目は必ずある', () => {
   equal([normalizeScale({ root: -3, mode: 'minor' }), normalizeScale(null)], [{ root: 9, mode: 'minor' }, { root: 0, mode: 'major' }]);
   equal(normalizeScales([{ bar: 5, root: 7, mode: 'major' }, { bar: 5, root: 2, mode: 'minor' }]),
      [{ bar: 1, root: 0, mode: 'major' }, { bar: 5, root: 2, mode: 'minor' }], '同じ小節は後のもの');
   equal(projectScales({}), [{ bar: 1, root: 0, mode: 'major' }]);
   const { project } = createProject({ title: 'p' });
   equal(project.scales, [{ bar: 1, root: 0, mode: 'major' }], '新しいプロジェクトは C メジャー');
   equal(updateProject(project, { scales: [{ bar: 1, root: '2', mode: 'minor' }] }).scales, [{ bar: 1, root: 2, mode: 'minor' }]);
   equal(createTemplate({ name: 't' }).project.scales, undefined, 'テンプレートは持たない');
});

test('scaleAt / scaleSpans: 転調ごとの区間', () => {
   const scales = [{ bar: 1, root: 0, mode: 'major' }, { bar: 9, root: 2, mode: 'major' }, { bar: 17, root: 9, mode: 'minor' }];
   equal([scaleAt(scales, 8), scaleAt(scales, 9), scaleAt(scales, 30)],
      [{ root: 0, mode: 'major' }, { root: 2, mode: 'major' }, { root: 9, mode: 'minor' }]);
   equal(scaleSpans(scales, 1, 4), [{ from: 0, to: 4, scale: { root: 0, mode: 'major' } }], '転調のないクリップ');
   equal(scaleSpans(scales, 7, 12), [
      { from: 0, to: 2, scale: { root: 0, mode: 'major' } },
      { from: 2, to: 10, scale: { root: 2, mode: 'major' } },
      { from: 10, to: 12, scale: { root: 9, mode: 'minor' } },
   ], '2回転調をまたぐ');
   equal(scaleSpans(scales, 9, 2), [{ from: 0, to: 2, scale: { root: 2, mode: 'major' } }], '頭が転調の小節');
});

test('setScaleAt / moveScale / removeScale', () => {
   const base = normalizeScales([]);
   const added = setScaleAt(base, 5, { root: 7, mode: 'major' });
   equal(added, [{ bar: 1, root: 0, mode: 'major' }, { bar: 5, root: 7, mode: 'major' }]);
   equal(setScaleAt(added, 1, { root: 4, mode: 'minor' })[0], { bar: 1, root: 4, mode: 'minor' }, 'あれば変える');
   equal(moveScale(added, 5, 3).map((s) => s.bar), [1, 3]);
   throws(() => moveScale(added, 1, 3), '1小節目は動かせない');
   throws(() => moveScale(added, 5, 1), 'ほかの転調と同じ小節');
   equal(removeScale(added, 5), base);
   throws(() => removeScale(added, 1), '1小節目は消せない');
   throws(() => removeScale(added, 4), 'ない小節');
   equal(base, [{ bar: 1, root: 0, mode: 'major' }], '受け取ったものは変えない');
});

test('inScale / scaleLabel', () => {
   const pick = (scale) => Array.from({ length: 12 }, (_, i) => 60 + i).filter((p) => inScale(p, scale)).map((p) => p - 60);
   equal(pick({ root: 0, mode: 'major' }), [0, 2, 4, 5, 7, 9, 11], 'C メジャー = 白鍵');
   equal(pick({ root: 9, mode: 'minor' }), [0, 2, 4, 5, 7, 9, 11], 'A マイナーも白鍵');
   equal(pick({ root: 2, mode: 'major' }), [1, 2, 4, 6, 7, 9, 11], 'D メジャー');
   equal(pick({ root: 4, mode: 'minor' }), [0, 2, 4, 6, 7, 9, 11], 'E マイナー');
   assert(inScale(1, { root: 1, mode: 'major' }) && !inScale(2, { root: 1, mode: 'major' }), '低い音でも');
   equal([scaleLabel({ root: 9, mode: 'minor' }), scaleLabel({})], ['A マイナー', 'C メジャー']);
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
   equal(data.tasks, [
      { id: 'a', startDate: null, endDate: null, clipId: null },
      { id: 'b', startDate: '2026-10-20', endDate: null, clipId: null },
   ]);
});

test('migrate: アレンジを持つ前のデータ(v5)は、アレンジなしとして読み込む', () => {
   const data = migrate({ schemaVersion: 5, projects: [{ id: 'p' }], tasks: [] });
   equal([data.schemaVersion, data.tracks, data.clips, data.markers], [SCHEMA_VERSION, [], [], []]);
   throws(() => migrate({ schemaVersion: SCHEMA_VERSION, clips: [{}] }), 'クリップに id なし');
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
// supabase.js が使う機能(eq / in の絞り込み、data->>項目 の絞り込み、limit と offset、upsert、delete)だけに応える。
function fakeSupabase({ key = 'KEY', failWith = null } = {}) {
   const tables = {};
   const respond = (status, body) => ({ ok: status < 400, status, json: async () => body });
   const keyOf = (table, row) => (table === 'app_meta' ? row.key : `${row.collection}/${row.id}`);
   const valueOf = (row, column) => (column.startsWith('data->>') ? row.data?.[column.slice(7)] : row[column]);
   const satisfies = (value, condition) => {
      if (condition.startsWith('in.(')) {
         return condition.slice(4, -1).split(',').map((v) => v.replace(/^"|"$/g, '')).includes(String(value));
      }
      return String(value) === condition.replace(/^eq\./, '');
   };
   const fetchImpl = async (input, { method, headers, body }) => {
      const url = new URL(input);
      const table = url.pathname.split('/').pop();
      if (headers.apikey !== key || headers.Authorization !== `Bearer ${key}`) {
         return respond(401, { message: 'Invalid API key' });
      }
      if (failWith) return respond(failWith.status, failWith.body);

      const rows = (tables[table] ??= []);
      const options = ['select', 'order', 'limit', 'offset'];
      const matches = (row) => [...url.searchParams]
         .every(([column, condition]) => options.includes(column) || satisfies(valueOf(row, column), condition));

      if (method === 'GET') {
         const offset = Number(url.searchParams.get('offset') ?? 0);
         const limit = Number(url.searchParams.get('limit') ?? 1000);
         const found = rows.filter(matches).sort((a, b) => (keyOf(table, a) < keyOf(table, b) ? -1 : 1));
         return respond(200, found.slice(offset, offset + limit));
      }
      if (method === 'POST') {
         for (const row of JSON.parse(body)) {
            const i = rows.findIndex((r) => keyOf(table, r) === keyOf(table, row));
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

// テーブルに入っている、あるコレクションのレコード
const stored = (tables, collection) => tables.records.filter((r) => r.collection === collection).map((r) => r.data);

test('supabase: レコードは形を問わず data(jsonb)に入れる。列に出すのはコレクション名・id・プロジェクトの id だけ', () => {
   const { project, tasks } = createProject({ title: 'x', dueDate: '2026-10-31' }, template('vocal'));
   equal(toRow('tasks', tasks[0]), { collection: 'tasks', id: tasks[0].id, project_id: project.id, data: tasks[0] });
   equal(toRow('projects', project).project_id, project.id, 'プロジェクトは自身の id');
   const extra = { ...setStatus(tasks[0], 'done'), removedLater: 1 };
   equal(fromRow(toRow('tasks', extra)), extra, '知らない項目もそのまま往復する');
});

test('supabase: 保存して読み戻せる。初期データの投入は1回だけ', async () => {
   const { tables, repository } = fakeSupabase();
   equal(await ensureSeeded(repository), true);
   equal(await ensureSeeded(repository), false, '2回目は入れない');
   // 初期データはテンプレート2つ。プロジェクトと同じコレクションに入る
   equal(Object.keys(tables).sort(), ['app_meta', 'records']);
   equal(['projects', 'lanes', 'tasks'].map((name) => stored(tables, name).length), [2, 17, 37]);
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

   await repository.saveTask({ ...tasks[0], title: '変更', removedLater: 1 });
   const saved = (await repository.getTasks(project.id)).find((t) => t.id === tasks[0].id);
   equal([saved.title, saved.removedLater, stored(tables, 'tasks').filter((t) => t.projectId === project.id).length],
      ['変更', 1, tasks.length], '同じIDは上書き。知らない項目があっても保存できる');
   await repository.deleteTask(tasks[0].id);
   equal((await repository.getTasks(project.id)).length, tasks.length - 1);

   const track = addTrack(project.id, [], 'ギター');
   const clip = addClip(track, [], { startBar: 1, bars: 2 });
   const marker = addMarker(project.id, [], lanes.find((l) => l.type === 'section'), 3);
   await repository.saveTrack(track);
   await repository.saveClip(clip);
   await repository.saveMarker(marker);
   equal([await repository.getTracks(project.id), await repository.getClips(project.id), await repository.getMarkers(project.id)],
      [[track], [clip], [marker]]);
   equal(await repository.getClips(other.project.id), [], 'プロジェクトで絞る');
   await repository.deleteClip(clip.id);
   await repository.deleteMarker(marker.id);
   equal([(await repository.getClips(project.id)).length, (await repository.getMarkers(project.id)).length], [0, 0]);
});

test('supabase: 削除すると、つながっているレコードも消える', async () => {
   const { tables, repository } = fakeSupabase();
   const save = async ({ project, lanes, tasks }) => {
      await repository.saveProject(project);
      await repository.saveLanes(lanes);
      await repository.saveTasks(tasks);
   };
   const a = createProject({ title: 'A' }, template('vocal'));
   const b = createProject({ title: 'B' }, template('inst'));
   await save(a);
   await save(b);
   const section = a.lanes.find((l) => l.type === 'section' && a.tasks.some((t) => t.laneId === l.id));
   const otherSection = b.lanes.find((l) => l.type === 'section');
   const [track, otherTrack] = [addTrack(a.project.id, [], 'ギター'), addTrack(a.project.id, [], 'ベース')];
   await repository.saveTracks([track, otherTrack]);
   await repository.saveClips([addClip(track, [], { startBar: 1, bars: 2 }), addClip(otherTrack, [], { startBar: 1, bars: 2 })]);
   await repository.saveMarkers([addMarker(a.project.id, [], section, 1), addMarker(b.project.id, [], otherSection, 1)]);

   // レーン → そのレーンのタスクとマーカー
   const inSection = a.tasks.filter((t) => t.laneId === section.id).length;
   await repository.deleteLane(section.id);
   equal([(await repository.getTasks(a.project.id)).length, (await repository.getMarkers(a.project.id)).length],
      [a.tasks.length - inSection, 0]);
   equal((await repository.getMarkers(b.project.id)).length, 1, '別のプロジェクトのマーカーは残る');

   // トラック → そのトラックのクリップ
   await repository.deleteTrack(track.id);
   equal((await repository.getClips(a.project.id)).map((c) => c.trackId), [otherTrack.id]);

   // プロジェクト → すべて
   await repository.deleteProject(a.project.id);
   assert(tables.records.every((r) => r.project_id !== a.project.id), 'プロジェクトのレコードが残っていない');
   equal((await repository.getLanes(b.project.id)).length, b.lanes.length, '別のプロジェクトは残る');
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
   const track = addTrack(project.id, [], 'ピアノ');
   const clip = addClip(track, [], { startBar: 5, bars: 4, name: 'リフ' });
   const marker = addMarker(project.id, [], lanes.find((l) => l.type === 'section'), 1);
   await a.saveTracks([track]);
   await a.saveClips([clip]);
   await a.saveMarkers([marker]);
   const exported = await a.exportAll();
   equal([exported.schemaVersion, exported.projects.length, exported.lanes.length, exported.tasks.length],
      [SCHEMA_VERSION, 3, 17 + 5, 37 + 5], 'テンプレートも含む');
   equal([exported.tracks, exported.clips, exported.markers], [[track], [clip], [marker]], 'アレンジも含む');

   const { tables, repository: b } = fakeSupabase();
   const old = createProject({ title: '消える' });
   await b.saveProject(old.project);
   await b.saveLanes(old.lanes);
   await b.importAll(JSON.stringify(exported));
   equal((await b.getProjects()).map((p) => p.title), ['曲A']);
   equal((await b.getTemplates()).length, 2);
   equal((await b.getLanes(old.project.id)).length, 0, '元からあったレコードは消える');
   equal(tables.records.length, 3 + 22 + 42 + 3, '余分な行が残らない');
   equal((await b.getTasks(project.id)).length, tasks.length);
   equal((await b.getTasks('seed-template-vocal')).length, 32);
   equal([await b.getTracks(project.id), await b.getClips(project.id), await b.getMarkers(project.id)],
      [[track], [clip], [marker]], 'アレンジも戻る');
   equal(await ensureSeeded(b), false, 'インポート後に初期データを重ねない');
   await rejects(b.importAll('{"x":1}'), 'エクスポートデータではありません');
});

test('upgradeStorage: 初めて使う保存先は、変換せずに現在のバージョンを記録する。同じなら何もしない', async () => {
   const { repository } = fakeSupabase();
   equal(await upgradeStorage(repository), false);
   equal(await repository.getMeta('schemaVersion'), SCHEMA_VERSION);
   equal(await upgradeStorage(repository), false);
   equal(await checkSchema(repository), SCHEMA_VERSION);
   equal(await ensureSeeded(repository), true, '初期データはこのあと入る');
});

test('upgradeStorage: 記録がなく、初期データの入っている保存先は v6 とみなして変換する', async () => {
   const { repository } = fakeSupabase();
   await ensureSeeded(repository);
   equal(await upgradeStorage(repository), true);
   equal(await repository.getMeta('schemaVersion'), SCHEMA_VERSION);
   equal((await repository.getTemplates()).length, 2, '初期データは残る');
});

test('upgradeStorage: 古ければ、変換前のデータを残してから変換して保存し直す', async () => {
   const { tables, repository } = fakeSupabase();
   const { project, lanes } = createProject({ title: '曲A' });
   // v4 のタスク(開始日と終了日がない)
   const { startDate, endDate, ...v4task } = setStatus(addTask(lanes[0], [], '作業中'), 'doing');
   await repository.saveProject(project);
   await repository.saveLanes(lanes);
   await repository.saveTasks([v4task]);
   await repository.setMeta('schemaVersion', 4);

   equal(await upgradeStorage(repository), true);
   equal(await repository.getMeta('schemaVersion'), SCHEMA_VERSION);
   const [task] = await repository.getTasks(project.id);
   equal([task.startDate, task.endDate], [null, null], '日付なしとして変換された');
   const backups = tables.app_meta.filter((m) => m.key.startsWith('backup:v4:'));
   equal(backups.length, 1, 'バックアップは1つ');
   equal([backups[0].value.schemaVersion, backups[0].value.tasks], [4, [v4task]], '変換前のまま残る');
   equal(await upgradeStorage(repository), false, '2回目は何もしない');
});

test('upgradeStorage: v8 の保存先は、v9 を飛ばして v10 に変換する(スケールは1小節目から C メジャー)', async () => {
   const { tables, repository } = fakeSupabase();
   const { project, lanes } = createProject({ title: '曲A' });
   const { scales, ...v8project } = { ...project, bpm: 140 };
   const { project: template } = createTemplate({ name: 'テンプレート' });
   await repository.saveProject(v8project);
   await repository.saveProject(template);
   await repository.saveLanes(lanes);
   await repository.setMeta('schemaVersion', 8);

   equal(await upgradeStorage(repository), true);
   equal(await repository.getMeta('schemaVersion'), SCHEMA_VERSION);
   const saved = await repository.getProject(project.id);
   equal([saved.bpm, saved.scales, 'scale' in saved], [140, [{ bar: 1, root: 0, mode: 'major' }], false]);
   equal((await repository.getProject(template.id)).scales, undefined, 'テンプレートには足さない');
   equal((await repository.getLanes(project.id)).length, lanes.length, 'ほかのデータはそのまま');
   const backups = tables.app_meta.filter((m) => m.key.startsWith('backup:v8:'));
   equal([backups.length, backups[0].value.projects.find((p) => p.id === project.id).scales], [1, undefined], '変換前のまま残る');
});

test('upgradeStorage: 新しければ止める(何も書き換えない)', async () => {
   const { tables, repository } = fakeSupabase();
   await repository.setMeta('schemaVersion', SCHEMA_VERSION + 1);
   const before = JSON.stringify(tables);
   await rejects(upgradeStorage(repository), '再読み込み');
   await rejects(checkSchema(repository), '再読み込み');
   equal(JSON.stringify(tables), before, '何も書き換えない');
   const error = await checkSchema(repository).catch((e) => e);
   assert(error instanceof NewerSchemaError, 'NewerSchemaError で失敗する');
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
   await rejects(checkConnection(config, async () => { throw new TypeError('Failed to fetch'); }), '接続できないため、読み込みも保存もできませんでした');
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
